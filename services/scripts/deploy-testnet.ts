/**
 * Deploy Hushd to NEAR testnet from one funded account (default hushd.testnet).
 *
 *   pnpm --filter @hushd/services deploy:testnet            # everything, skipping what exists
 *   DRY_RUN=1 pnpm --filter @hushd/services deploy:testnet  # print the plan and the NEAR it needs
 *
 * Each contract account is created, funded, given the deployer's key, deployed and
 * initialised in one transaction. Service accounts (relayer, matcher, keeper, three
 * makers) get fresh keys, written to `.env.testnet` (gitignored) with the makers' wallet
 * seeds and quote keys. Then: the relayer named a faucet operator on each token, storage
 * registrations, maker inventory shielded into the pool, maker bonds posted on the desk.
 * The result goes to `deployments/testnet.json`.
 *
 * Reads the deployer key from DEPLOYER_PRIVATE_KEY or ~/.near-credentials/testnet/<id>.json.
 * The OutLayer matcher project is a separate step (see the runbook): the desk's
 * enclave key comes from `refresh_enclave_key` once the project exists.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { accountBalance, identityFromSeed, loadPoseidon, makeNote, sealNote, shieldCall, TESTNET, view, withOverrides } from "@hushd/sdk";
import { Near } from "near-kit";

const ROOT = new URL("../..", import.meta.url).pathname;
const DEPLOYER = process.env.DEPLOYER_ACCOUNT ?? "hushd.testnet";
const DRY = process.env.DRY_RUN === "1";
const NEAR = 10n ** 24n;
const near = (x: number) => (BigInt(Math.round(x * 1000)) * NEAR) / 1000n;
const net = withOverrides(TESTNET, process.env.NEAR_RPC_URL ? { rpc: process.env.NEAR_RPC_URL.split(",") } : {});
const sub = (name: string) => `${name}.${DEPLOYER}`;

function deployerKey(): string {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
  const f = join(homedir(), ".near-credentials", "testnet", `${DEPLOYER}.json`);
  if (!existsSync(f)) throw new Error(`No key for ${DEPLOYER}: set DEPLOYER_PRIVATE_KEY or create ${f}`);
  return (JSON.parse(readFileSync(f, "utf8")) as { private_key: string }).private_key;
}

function keypair() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  return { publicKey: `ed25519:${base58.encode(pub)}`, privateKey: `ed25519:${base58.encode(new Uint8Array([...secret, ...pub]))}` };
}

const wasm = (name: string) => {
  const p = join(ROOT, "contracts/target/near", `hushd_${name}`, `hushd_${name}.wasm`);
  if (!existsSync(p)) throw new Error(`${p} is missing: run \`cargo near build non-reproducible-wasm\` in contracts/${name}`);
  return new Uint8Array(readFileSync(p));
};
const codeHash = (b: Uint8Array) => base58.encode(createHash("sha256").update(b).digest());

// minDeposit keeps dust out of the tree: 1 USDC, 0.1 wNEAR, 0.00001 BTC
const TOKENS = [
  { name: "usdc", symbol: "USDC", title: "Hushd test USDC", decimals: 6, faucet: 10_000n * 10n ** 6n, minDeposit: 10n ** 6n, perDeposit: 1_000_000n * 10n ** 6n, total: 100_000_000n * 10n ** 6n },
  { name: "wnear", symbol: "wNEAR", title: "Hushd test wNEAR", decimals: 24, faucet: 1_000n * NEAR, minDeposit: NEAR / 10n, perDeposit: 1_000_000n * NEAR, total: 100_000_000n * NEAR },
  { name: "btc", symbol: "BTC", title: "Hushd test BTC", decimals: 8, faucet: 1n * 10n ** 8n, minDeposit: 1_000n, perDeposit: 100n * 10n ** 8n, total: 10_000n * 10n ** 8n },
];
const DAY_NS = 24n * 3_600n * 10n ** 9n;
const SERVICES = ["relayer", "matcher", "keeper", "maker-a", "maker-b", "maker-c"] as const;
const FUND: Record<string, bigint> = { pool: near(6), desk: near(5), board: near(3), usdc: near(3), wnear: near(3), btc: near(3), relayer: near(8), matcher: near(3), keeper: near(3), "maker-a": near(2), "maker-b": near(2), "maker-c": near(2) };
const MAKER_INVENTORY = { usdc: 500_000n * 10n ** 6n, wnear: 50_000n * NEAR, btc: 8n * 10n ** 8n };
const MAKER_BOND = 20_000n * 10n ** 6n;

type Report = { network: string; deployer: string; deployedAt: string; contracts: Record<string, { account: string; codeHash: string; tx: string }>; services: Record<string, string>; steps: { what: string; tx: string }[] };

async function main() {
  const total = Object.values(FUND).reduce((a, b) => a + b, 0n) + near(2);
  console.log(`Deployer ${DEPLOYER}; needs about ${total / NEAR} NEAR (accounts, storage, gas).`);
  const bal = await accountBalance(net, DEPLOYER);
  console.log(`Balance: ${bal === null ? "account does not exist" : `${Number(bal / 10n ** 21n) / 1000} NEAR`}`);
  if (DRY) {
    for (const [k, v] of Object.entries(FUND)) console.log(`  ${sub(k)}: ${Number(v / 10n ** 21n) / 1000} NEAR`);
    return;
  }
  if (bal === null || bal < total) throw new Error(`Fund ${DEPLOYER} with at least ${total / NEAR} NEAR first`);

  const key = deployerKey();
  const pub = `ed25519:${base58.encode(base58.decode(key.slice(8)).slice(32))}`;
  const client = new Near({ network: { networkId: "testnet", rpcUrl: net.rpc[0]! }, privateKey: key as `ed25519:${string}`, defaultSignerId: DEPLOYER, defaultWaitUntil: "FINAL" });
  const report: Report = { network: "testnet", deployer: DEPLOYER, deployedAt: new Date().toISOString(), contracts: {}, services: {}, steps: [] };
  const hashOf = (o: unknown) => (o as { transaction?: { hash?: string } }).transaction?.hash ?? "";
  const exists = async (acc: string) => (await accountBalance(net, acc)) !== null;

  // ---------- contracts ----------
  const deploy = async (name: string, code: Uint8Array, init: object) => {
    const acc = sub(name);
    if (await exists(acc)) {
      console.log(`= ${acc} exists, skipped`);
      report.contracts[name] = { account: acc, codeHash: codeHash(code), tx: "" };
      return;
    }
    const out = await client.transaction(DEPLOYER).createAccount(acc).transfer(acc, FUND[name]!).addKey(pub, { type: "fullAccess" }).deployContract(acc, code).functionCall(acc, "new", init, { gas: "100 Tgas" }).send();
    report.contracts[name] = { account: acc, codeHash: codeHash(code), tx: hashOf(out) };
    console.log(`+ ${acc} deployed (${hashOf(out)})`);
  };

  const tokenCode = wasm("token");
  for (const t of TOKENS) {
    await deploy(t.name, tokenCode, { owner_id: DEPLOYER, name: t.title, symbol: t.symbol, decimals: t.decimals, icon: null, faucet_amount: t.faucet.toString(), faucet_cooldown_ns: (3_600n * 10n ** 9n).toString() });
  }
  await deploy("pool", wasm("pool"), {
    owner_id: DEPLOYER,
    desk_id: sub("desk"),
    timelock_ns: DAY_NS.toString(),
    assets: TOKENS.map((t) => ({ token: sub(t.name), limits: { per_deposit: t.perDeposit.toString(), total: t.total.toString(), min_deposit: t.minDeposit.toString() } })),
  });
  await deploy("board", wasm("board"), { owner_id: DEPLOYER, max_post_bytes: 2048 });
  await deploy("desk", wasm("desk"), {
    config: {
      owner: DEPLOYER,
      pool: sub("pool"),
      bond_token: sub("usdc"),
      outlayer: net.outlayer,
      matcher_project: `${DEPLOYER}/matcher`,
      secrets_owner: DEPLOYER,
      mpc: net.mpc,
      keeper: sub("keeper"),
      outlayer_fee: (10n ** 23n).toString(),
      min_bond: (1_000n * 10n ** 6n).toString(),
      // pool, bond token and MPC are fixed for good; anything else waits a day after propose_config
      config_timelock_ns: DAY_NS.toString(),
    },
  });

  // ---------- service accounts ----------
  const envPath = join(ROOT, ".env.testnet");
  const envLines: string[] = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n").filter(Boolean) : [];
  const envHas = (k: string) => envLines.some((l) => l.startsWith(`${k}=`));
  const setEnv = (k: string, v: string) => {
    if (!envHas(k)) envLines.push(`${k}=${v}`);
  };
  const envGet = (k: string) => envLines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
  for (const s of SERVICES) {
    const acc = sub(s);
    const prefix = s.replace("-", "_").toUpperCase();
    report.services[s] = acc;
    if (await exists(acc)) {
      console.log(`= ${acc} exists, skipped`);
      continue;
    }
    const kp = keypair();
    let tx = client.transaction(DEPLOYER).createAccount(acc).transfer(acc, FUND[s]!).addKey(kp.publicKey, { type: "fullAccess" });
    if (s === "relayer") {
      const gas = keypair();
      tx = tx.addKey(gas.publicKey, { type: "gasKeyFullAccess", numNonces: 8 } as never);
      setEnv("RELAYER_GAS_KEY", gas.privateKey);
      setEnv("RELAYER_LANES", "8");
    }
    const out = await tx.send();
    setEnv(`${prefix}_ACCOUNT`, acc);
    setEnv(`${prefix}_PRIVATE_KEY`, kp.privateKey);
    if (s.startsWith("maker-")) {
      setEnv(`${prefix}_SEED`, randomBytes(32).toString("hex"));
      setEnv(`${prefix}_QUOTE_KEY`, base58.encode(ed25519.utils.randomSecretKey()));
    }
    report.steps.push({ what: `create ${acc}`, tx: hashOf(out) });
    console.log(`+ ${acc} created`);
  }
  writeFileSync(envPath, `${envLines.join("\n")}\n`, { mode: 0o600 });
  if (envGet("RELAYER_GAS_KEY")) {
    const gasPub = `ed25519:${base58.encode(base58.decode(envGet("RELAYER_GAS_KEY")!.slice(8)).slice(32))}`;
    const funded = await client.transaction(DEPLOYER).transferToGasKey(gasPub, near(3)).send().catch(() => null);
    if (funded) report.steps.push({ what: "fund the relayer's gas key", tx: hashOf(funded) });
  }

  // ---------- storage, inventory, bonds ----------
  const call = async (signer: Near, from: string, contract: string, method: string, args: object, deposit = 0n, gas = "100 Tgas") => {
    const out = await signer.transaction(from).functionCall(contract, method, args, { gas: gas as `${number} Tgas`, attachedDeposit: deposit }).send();
    report.steps.push({ what: `${from} -> ${contract}.${method}`, tx: hashOf(out) });
    return out;
  };
  // only the owner and its operators may faucet for another account: the relayer funds passkey accounts
  for (const t of TOKENS) {
    if (!(await view<boolean>(net, sub(t.name), "is_operator", { account_id: sub("relayer") }))) {
      await call(client, DEPLOYER, sub(t.name), "set_operator", { account_id: sub("relayer"), allowed: true }, 1n, "30 Tgas");
    }
  }

  const registered = async (token: string, acc: string) => (await view<unknown>(net, token, "storage_balance_of", { account_id: acc })) !== null;
  const STORAGE = 1_250_000_000_000_000_000_000n;
  for (const t of TOKENS) {
    for (const acc of [sub("pool"), sub("desk"), ...SERVICES.filter((s) => s.startsWith("maker-")).map(sub)]) {
      if (!(await registered(sub(t.name), acc))) await call(client, DEPLOYER, sub(t.name), "storage_deposit", { account_id: acc, registration_only: true }, STORAGE, "30 Tgas");
    }
  }

  await loadPoseidon();
  const shieldNet = withOverrides(net, { pool: sub("pool"), board: sub("board"), desk: sub("desk"), tokens: TOKENS.map((t) => ({ id: sub(t.name), symbol: t.symbol, decimals: t.decimals })) });
  for (const m of ["maker-a", "maker-b", "maker-c"] as const) {
    const prefix = m.replace("-", "_").toUpperCase();
    const acc = sub(m);
    const pk = envGet(`${prefix}_PRIVATE_KEY`);
    const seedHex = envGet(`${prefix}_SEED`);
    if (!pk || !seedHex) {
      console.log(`= ${acc}: keys not in .env.testnet, inventory skipped`);
      continue;
    }
    const maker = new Near({ network: { networkId: "testnet", rpcUrl: net.rpc[0]! }, privateKey: pk as `ed25519:${string}`, defaultSignerId: acc, defaultWaitUntil: "FINAL" });
    const id = identityFromSeed(Uint8Array.from(Buffer.from(seedHex, "hex")));
    await call(maker, acc, sub("board"), "storage_deposit", { account_id: acc, registration_only: null }, near(0.5), "30 Tgas");
    for (const t of TOKENS) {
      const amount = MAKER_INVENTORY[t.name as keyof typeof MAKER_INVENTORY] + (t.name === "usdc" ? MAKER_BOND : 0n);
      await call(client, DEPLOYER, sub(t.name), "mint", { account_id: acc, amount: amount.toString() }, 0n, "30 Tgas");
      const note = makeNote(id.pk, sub(t.name), MAKER_INVENTORY[t.name as keyof typeof MAKER_INVENTORY]);
      // the self post first, so the maker's wallet finds the note on the board
      await call(maker, acc, sub("board"), "post", { ciphertext: sealNote(id, note), tag: "note" }, 0n, "30 Tgas");
      const c = shieldCall(shieldNet, note);
      await call(maker, acc, c.contract, c.method, c.args, 1n, "120 Tgas");
    }
    await call(maker, acc, sub("usdc"), "ft_transfer_call", { receiver_id: sub("desk"), amount: MAKER_BOND.toString(), memo: null, msg: "bond" }, 1n, "100 Tgas");
    console.log(`+ ${acc}: inventory shielded, bond posted`);
  }

  mkdirSync(join(ROOT, "deployments"), { recursive: true });
  writeFileSync(join(ROOT, "deployments/testnet.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("Wrote deployments/testnet.json and .env.testnet (keys: keep it private).");
}

main().catch((e) => {
  console.error("deploy:", (e as Error).message);
  process.exit(1);
});
