/**
 * Deploy Hushd from one funded account: testnet (default, `hushd.testnet`) or mainnet
 * (`hushd.near`). The same code runs both; only the profile below differs.
 *
 *   pnpm --filter @hushd/services deploy:testnet            # everything, skipping what exists
 *   pnpm --filter @hushd/services deploy:mainnet            # mainnet: prints the plan and the NEAR it needs, sends nothing
 *   DRY_RUN=1 pnpm --filter @hushd/services deploy:testnet  # print the plan
 *
 * Testnet deploys three test tokens with a faucet; mainnet uses the real tokens in the
 * SDK's MAINNET config (native USDC, wrap.near, nbtc.bridge.near) and deploys none.
 * A mainnet deploy sends only against a local node (a sandbox, NEAR_RPC_URL=http://localhost...)
 * or with HUSHD_MAINNET_GO set to the deployer account, which the owner sets after saying yes.
 *
 * Each contract account is created, funded, given the deployer's key, deployed and
 * initialised in one transaction. Service accounts (relayer, matcher, keeper, three
 * makers) get fresh keys, written to `.env.<network>` (gitignored) with the makers' wallet
 * seeds and quote keys. Then: storage registrations, maker inventory shielded into the
 * pool and maker bonds posted on the desk (testnet mints them; on mainnet the makers
 * must already hold the tokens). The result goes to `deployments/<network>.json`.
 *
 * Contract code: the reproducible builds in contracts/target/near (`cargo near build
 * reproducible-wasm`). Reads the deployer key from DEPLOYER_PRIVATE_KEY or
 * ~/.near-credentials/<network>/<id>.json. The OutLayer matcher project is a separate
 * step: the desk's enclave key comes from `refresh_enclave_key` once the project exists.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { accountBalance, identityFromSeed, keepRpcErrorBodies, loadPoseidon, MAINNET, makeNote, sealNote, sendEndpoints, shieldCall, TESTNET, view, withOverrides, type HushdNetwork } from "@hushd/sdk";
import { Near } from "near-kit";

const ROOT = new URL("../..", import.meta.url).pathname;
const NEAR = 10n ** 24n;
const near = (x: number) => (BigInt(Math.round(x * 1000)) * NEAR) / 1000n;
const DAY_NS = 24n * 3_600n * 10n ** 9n;
const SERVICES = ["relayer", "matcher", "keeper", "maker-a", "maker-b", "maker-c"] as const;
const MAKERS = ["maker-a", "maker-b", "maker-c"] as const;

interface TokenPlan {
  name: string;
  symbol: string;
  decimals: number;
  /** The account on mainnet; on testnet `<name>.<deployer>`, deployed here with a faucet. */
  id?: string;
  title?: string;
  faucet?: bigint;
  minDeposit: bigint;
  perDeposit: bigint;
  total: bigint;
  /** What each maker shields as quoting inventory. */
  inventory: bigint;
}

interface Profile {
  base: HushdNetwork;
  deployer: string;
  tokens: TokenPlan[];
  fund: Record<string, bigint>;
  bond: bigint;
  minBond: bigint;
  outlayerFee: bigint;
}

// minDeposit keeps dust out of the tree: 1 USDC, 0.1 wNEAR, 0.00001 BTC
const TESTNET_PROFILE: Profile = {
  base: TESTNET,
  deployer: "hushd.testnet",
  tokens: [
    { name: "usdc", symbol: "USDC", title: "Hushd test USDC", decimals: 6, faucet: 10_000n * 10n ** 6n, minDeposit: 10n ** 6n, perDeposit: 1_000_000n * 10n ** 6n, total: 100_000_000n * 10n ** 6n, inventory: 500_000n * 10n ** 6n },
    { name: "wnear", symbol: "wNEAR", title: "Hushd test wNEAR", decimals: 24, faucet: 1_000n * NEAR, minDeposit: NEAR / 10n, perDeposit: 1_000_000n * NEAR, total: 100_000_000n * NEAR, inventory: 50_000n * NEAR },
    { name: "btc", symbol: "BTC", title: "Hushd test BTC", decimals: 8, faucet: 1n * 10n ** 8n, minDeposit: 1_000n, perDeposit: 100n * 10n ** 8n, total: 10_000n * 10n ** 8n, inventory: 8n * 10n ** 8n },
  ],
  fund: { pool: near(6), desk: near(5), board: near(3), usdc: near(3), wnear: near(3), btc: near(3), relayer: near(8), matcher: near(3), keeper: near(3), "maker-a": near(2), "maker-b": near(2), "maker-c": near(2) },
  bond: 20_000n * 10n ** 6n,
  minBond: 1_000n * 10n ** 6n,
  outlayerFee: 10n ** 23n,
};

// Mainnet starts small: the pool's caps are the most real value it can hold, and they rise
// only through the pool's one-day timelock. Inventory and bonds are what makers bring.
const MAINNET_PROFILE: Profile = {
  base: MAINNET,
  deployer: "hushd.near",
  tokens: [
    { name: "usdc", symbol: "USDC", id: MAINNET.tokens[0]!.id, decimals: 6, minDeposit: 10n ** 6n, perDeposit: 10_000n * 10n ** 6n, total: 100_000n * 10n ** 6n, inventory: 2_000n * 10n ** 6n },
    { name: "wnear", symbol: "wNEAR", id: "wrap.near", decimals: 24, minDeposit: NEAR / 10n, perDeposit: 5_000n * NEAR, total: 50_000n * NEAR, inventory: 500n * NEAR },
    { name: "btc", symbol: "BTC", id: "nbtc.bridge.near", decimals: 8, minDeposit: 1_000n, perDeposit: 20_000_000n, total: 200_000_000n, inventory: 2_000_000n },
  ],
  fund: { pool: near(6), desk: near(5), board: near(3), relayer: near(5), matcher: near(2), keeper: near(2), "maker-a": near(1), "maker-b": near(1), "maker-c": near(1) },
  bond: 1_000n * 10n ** 6n,
  minBond: 500n * 10n ** 6n,
  outlayerFee: 10n ** 23n,
};

export interface DeployOptions {
  network: "testnet" | "mainnet";
  /** RPC endpoints (a sandbox node); default the network's own. */
  rpc?: string[];
  deployer?: string;
  deployerKey?: string;
  /** Where service keys go (default `.env.<network>` in the repo) and the report (default `deployments/<network>.json`). */
  envPath?: string;
  reportPath?: string;
  dryRun?: boolean;
  log?: (s: string) => void;
}

type Report = { network: string; deployer: string; deployedAt: string; contracts: Record<string, { account: string; codeHash: string; tx: string }>; services: Record<string, string>; steps: { what: string; tx: string }[] };

const wasm = (name: string) => {
  const p = join(ROOT, "contracts/target/near", `hushd_${name}`, `hushd_${name}.wasm`);
  if (!existsSync(p)) throw new Error(`${p} is missing: run \`cargo near build reproducible-wasm\` in contracts/${name}`);
  return new Uint8Array(readFileSync(p));
};
const codeHash = (b: Uint8Array) => base58.encode(createHash("sha256").update(b).digest());

function keypair() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  return { publicKey: `ed25519:${base58.encode(pub)}`, privateKey: `ed25519:${base58.encode(new Uint8Array([...secret, ...pub]))}` };
}

const isLocal = (url: string) => /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);

export async function deployHushd(o: DeployOptions): Promise<{ report: Report; net: HushdNetwork; env: Record<string, string> }> {
  const profile = o.network === "mainnet" ? MAINNET_PROFILE : TESTNET_PROFILE;
  const log = o.log ?? ((s: string) => console.log(s));
  const DEPLOYER = o.deployer ?? profile.deployer;
  const sub = (name: string) => `${name}.${DEPLOYER}`;
  const tokenId = (t: TokenPlan) => t.id ?? sub(t.name);
  const deployTokens = o.network === "testnet";
  const net0 = withOverrides(profile.base, o.rpc ? { rpc: o.rpc } : {});
  keepRpcErrorBodies(net0.rpc);
  if (o.network === "mainnet" && !o.dryRun && !net0.rpc.every(isLocal) && process.env.HUSHD_MAINNET_GO !== DEPLOYER) {
    throw new Error(`Refusing to send on NEAR mainnet: the owner says yes first, then HUSHD_MAINNET_GO=${DEPLOYER}`);
  }
  // the network the contracts and services will use once this is done
  const net = withOverrides(net0, { pool: sub("pool"), desk: sub("desk"), board: sub("board"), bondToken: tokenId(profile.tokens[0]!), tokens: profile.tokens.map((t) => ({ ...profile.base.tokens.find((b) => b.symbol === t.symbol), id: tokenId(t), symbol: t.symbol, decimals: t.decimals })) });

  // only accounts that do not exist yet still need their NEAR (a rerun skips the rest)
  const missing = (await Promise.all(Object.keys(profile.fund).map(async (k) => ((await accountBalance(net, sub(k))) === null ? k : null)))).filter((k): k is string => k !== null);
  const total = missing.reduce((a, k) => a + profile.fund[k]!, 0n) + near(2);
  log(`Deployer ${DEPLOYER} on ${o.network}${o.rpc ? ` (${o.rpc.join(", ")})` : ""}; needs about ${total / NEAR} NEAR (accounts, storage, gas).`);
  const bal = await accountBalance(net, DEPLOYER);
  log(`Balance: ${bal === null ? "account does not exist" : `${Number(bal / 10n ** 21n) / 1000} NEAR`}`);
  const report: Report = { network: o.network, deployer: DEPLOYER, deployedAt: new Date().toISOString(), contracts: {}, services: {}, steps: [] };
  if (o.dryRun) {
    for (const [k, v] of Object.entries(profile.fund).filter(([k]) => missing.includes(k))) log(`  ${sub(k)}: ${Number(v / 10n ** 21n) / 1000} NEAR`);
    for (const t of profile.tokens) log(`  pool takes ${t.symbol} (${tokenId(t)}): at most ${t.perDeposit} per deposit, ${t.total} in all`);
    return { report, net, env: {} };
  }
  if (bal === null || bal < total) throw new Error(`Fund ${DEPLOYER} with at least ${total / NEAR} NEAR first`);

  const key = o.deployerKey ?? process.env.DEPLOYER_PRIVATE_KEY ?? readCredential(o.network, DEPLOYER);
  const pub = `ed25519:${base58.encode(base58.decode(key.slice(8)).slice(32))}`;
  const signer = (account: string, k: string) => new Near({ network: { networkId: o.network, rpcUrl: sendEndpoints(net)[0]! }, privateKey: k as `ed25519:${string}`, defaultSignerId: account, defaultWaitUntil: "FINAL" });
  const client = signer(DEPLOYER, key);
  const hashOf = (out: unknown) => (out as { transaction?: { hash?: string } }).transaction?.hash ?? "";
  const exists = async (acc: string) => (await accountBalance(net, acc)) !== null;

  // ---------- contracts ----------
  const deploy = async (name: string, code: Uint8Array, init: object) => {
    const acc = sub(name);
    if (await exists(acc)) {
      log(`= ${acc} exists, skipped`);
      report.contracts[name] = { account: acc, codeHash: codeHash(code), tx: "" };
      return;
    }
    const out = await client.transaction(DEPLOYER).createAccount(acc).transfer(acc, profile.fund[name]!).addKey(pub, { type: "fullAccess" }).deployContract(acc, code).functionCall(acc, "new", init, { gas: "100 Tgas" }).send();
    report.contracts[name] = { account: acc, codeHash: codeHash(code), tx: hashOf(out) };
    log(`+ ${acc} deployed (${hashOf(out)})`);
  };

  if (deployTokens) {
    const tokenCode = wasm("token");
    for (const t of profile.tokens) {
      await deploy(t.name, tokenCode, { owner_id: DEPLOYER, name: t.title, symbol: t.symbol, decimals: t.decimals, icon: null, faucet_amount: t.faucet!.toString(), faucet_cooldown_ns: (3_600n * 10n ** 9n).toString() });
    }
  }
  await deploy("pool", wasm("pool"), {
    owner_id: DEPLOYER,
    desk_id: sub("desk"),
    timelock_ns: DAY_NS.toString(),
    assets: profile.tokens.map((t) => ({ token: tokenId(t), limits: { per_deposit: t.perDeposit.toString(), total: t.total.toString(), min_deposit: t.minDeposit.toString() } })),
  });
  await deploy("board", wasm("board"), { owner_id: DEPLOYER, max_post_bytes: 2048 });
  await deploy("desk", wasm("desk"), {
    config: {
      owner: DEPLOYER,
      pool: sub("pool"),
      bond_token: tokenId(profile.tokens[0]!),
      outlayer: net.outlayer,
      matcher_project: `${DEPLOYER}/matcher`,
      secrets_owner: DEPLOYER,
      mpc: net.mpc,
      keeper: sub("keeper"),
      outlayer_fee: profile.outlayerFee.toString(),
      min_bond: profile.minBond.toString(),
      // pool, bond token and MPC are fixed for good; anything else waits a day after propose_config
      config_timelock_ns: DAY_NS.toString(),
    },
  });

  // ---------- service accounts ----------
  const envPath = o.envPath ?? join(ROOT, `.env.${o.network}`);
  const envLines: string[] = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n").filter(Boolean) : [];
  const envGet = (k: string) => envLines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
  const setEnv = (k: string, v: string) => {
    if (envGet(k) === undefined) envLines.push(`${k}=${v}`);
  };
  let relayerCreated = false;
  for (const s of SERVICES) {
    const acc = sub(s);
    const prefix = s.replace("-", "_").toUpperCase();
    report.services[s] = acc;
    if (await exists(acc)) {
      log(`= ${acc} exists, skipped`);
      continue;
    }
    const kp = keypair();
    let tx = client.transaction(DEPLOYER).createAccount(acc).transfer(acc, profile.fund[s]!).addKey(kp.publicKey, { type: "fullAccess" });
    if (s === "relayer") {
      relayerCreated = true;
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
      setEnv(`${prefix}_QUOTE_KEY`, Buffer.from(ed25519.utils.randomSecretKey()).toString("hex"));
    }
    report.steps.push({ what: `create ${acc}`, tx: hashOf(out) });
    log(`+ ${acc} created`);
  }
  writeFileSync(envPath, `${envLines.join("\n")}\n`, { mode: 0o600 });
  if (relayerCreated && envGet("RELAYER_GAS_KEY")) {
    const gasPub = `ed25519:${base58.encode(base58.decode(envGet("RELAYER_GAS_KEY")!.slice(8)).slice(32))}`;
    // the gas key lives on the relayer's account, so the relayer moves its own NEAR into it
    const funded = await signer(sub("relayer"), envGet("RELAYER_PRIVATE_KEY")!).transaction(sub("relayer")).transferToGasKey(gasPub, o.network === "mainnet" ? near(2) : near(3)).send();
    report.steps.push({ what: "fund the relayer's gas key", tx: hashOf(funded) });
  }

  // ---------- storage, inventory, bonds ----------
  const call = async (by: Near, from: string, contract: string, method: string, args: object, deposit = 0n, gas = "100 Tgas") => {
    const out = await by.transaction(from).functionCall(contract, method, args, { gas: gas as `${number} Tgas`, attachedDeposit: deposit }).send();
    report.steps.push({ what: `${from} -> ${contract}.${method}`, tx: hashOf(out) });
    return out;
  };
  if (deployTokens) {
    // only the owner and its operators may faucet for another account: the relayer funds passkey accounts
    for (const t of profile.tokens) {
      if (!(await view<boolean>(net, tokenId(t), "is_operator", { account_id: sub("relayer") }))) {
        await call(client, DEPLOYER, tokenId(t), "set_operator", { account_id: sub("relayer"), allowed: true }, 1n, "30 Tgas");
      }
    }
  }

  const registered = async (token: string, acc: string) => (await view<unknown>(net, token, "storage_balance_of", { account_id: acc })) !== null;
  for (const t of profile.tokens) {
    // each token names its own storage price
    const storage = BigInt((await view<{ min: string }>(net, tokenId(t), "storage_balance_bounds")).min);
    // the relayer too: a cash out pays its fee in the token itself (on mainnet; testnet charges none)
    for (const acc of [sub("pool"), sub("desk"), sub("relayer"), ...MAKERS.map(sub)]) {
      if (!(await registered(tokenId(t), acc))) await call(client, DEPLOYER, tokenId(t), "storage_deposit", { account_id: acc, registration_only: true }, storage, "30 Tgas");
    }
  }

  await loadPoseidon();
  const usdc = profile.tokens[0]!;
  for (const m of MAKERS) {
    const prefix = m.replace("-", "_").toUpperCase();
    const acc = sub(m);
    const pk = envGet(`${prefix}_PRIVATE_KEY`);
    const seedHex = envGet(`${prefix}_SEED`);
    if (!pk || !seedHex) {
      log(`= ${acc}: keys not in ${envPath}, inventory skipped`);
      continue;
    }
    const maker = signer(acc, pk);
    const id = identityFromSeed(Uint8Array.from(Buffer.from(seedHex, "hex")));
    await call(maker, acc, sub("board"), "storage_deposit", { account_id: acc, registration_only: null }, near(0.5), "30 Tgas");
    for (const t of profile.tokens) {
      const bond = t === usdc ? profile.bond : 0n;
      if (deployTokens) await call(client, DEPLOYER, tokenId(t), "mint", { account_id: acc, amount: (t.inventory + bond).toString() }, 0n, "30 Tgas");
      // on mainnet a maker shields what it brought, up to its inventory, keeping its bond back
      const held = BigInt(await view<string>(net, tokenId(t), "ft_balance_of", { account_id: acc }));
      const amount = held - bond < t.inventory ? held - bond : t.inventory;
      if (amount < t.minDeposit) {
        log(`= ${acc} holds no ${t.symbol} to shield`);
        continue;
      }
      const note = makeNote(id.pk, tokenId(t), amount);
      // the self post first, so the maker's wallet finds the note on the board
      await call(maker, acc, sub("board"), "post", { ciphertext: sealNote(id, note), tag: "note" }, 0n, "30 Tgas");
      const c = shieldCall(net, note);
      await call(maker, acc, c.contract, c.method, c.args, 1n, "120 Tgas");
    }
    // the desk takes a bond only from a registered maker, so register first (the maker service keeps it current)
    const quoteKeyHex = envGet(`${prefix}_QUOTE_KEY`)!;
    const quoteKey = `ed25519:${base58.encode(ed25519.getPublicKey(Uint8Array.from(Buffer.from(quoteKeyHex, "hex"))))}`;
    const style = { "maker-a": "fixed", "maker-b": "volatility", "maker-c": "inventory" }[m];
    const name = { "maker-a": "Steady", "maker-b": "Weather", "maker-c": "Ledger" }[m];
    if ((await view<unknown>(net, sub("desk"), "maker", { account_id: acc })) === null) {
      await call(maker, acc, sub("desk"), "register_maker", { name, enc_key: `0x${Buffer.from(id.encPublic).toString("hex")}`, quote_url: `${net.api}/makers/${acc}/quote`, style, quote_key: quoteKey }, 10n ** 22n, "30 Tgas");
    }
    if (BigInt(await view<string>(net, tokenId(usdc), "ft_balance_of", { account_id: acc })) >= profile.bond) {
      await call(maker, acc, tokenId(usdc), "ft_transfer_call", { receiver_id: sub("desk"), amount: profile.bond.toString(), memo: null, msg: "bond" }, 1n, "100 Tgas");
      log(`+ ${acc}: inventory shielded, bond posted`);
    } else log(`= ${acc}: not enough USDC for its ${profile.bond} bond yet`);
  }

  const reportPath = o.reportPath ?? join(ROOT, `deployments/${o.network}.json`);
  mkdirSync(join(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log(`Wrote ${reportPath} and ${envPath} (keys: keep it private).`);
  return { report, net, env: Object.fromEntries(envLines.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])) };
}

function readCredential(network: string, account: string): string {
  const f = join(homedir(), ".near-credentials", network, `${account}.json`);
  if (!existsSync(f)) throw new Error(`No key for ${account}: set DEPLOYER_PRIVATE_KEY or create ${f}`);
  return (JSON.parse(readFileSync(f, "utf8")) as { private_key: string }).private_key;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const network = process.env.HUSHD_NETWORK === "mainnet" ? "mainnet" : "testnet";
  // a mainnet run without the owner's go-ahead only prints the plan
  const dryRun = process.env.DRY_RUN === "1" || (network === "mainnet" && !process.env.NEAR_RPC_URL && process.env.HUSHD_MAINNET_GO === undefined);
  deployHushd({ network, rpc: process.env.NEAR_RPC_URL?.split(","), deployer: process.env.DEPLOYER_ACCOUNT, dryRun }).catch((e) => {
    console.error("deploy:", (e as Error).message);
    process.exit(1);
  });
}
