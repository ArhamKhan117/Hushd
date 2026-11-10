/**
 * Hushd's mainnet build, end to end on a local NEAR node, before anything touches mainnet.
 *
 *   pnpm --filter @hushd/services mainnet:sandbox
 *
 * A near-sandbox node at nearcore 2.14.0 (what mainnet runs) is given the real mainnet
 * accounts Hushd depends on, with their exact mainnet code (read with view_code, hash
 * checked against mainnet): native USDC (Circle's FiatToken), wrap.near and
 * nbtc.bridge.near. Their mainnet balances are too large to copy, so each starts fresh
 * and is funded the way that code allows: USDC through its minter roles, wNEAR by
 * wrapping NEAR, BTC by its controller. Then:
 *
 * - `scripts/deploy.ts` deploys Hushd with the MAINNET profile as `hushd.near`, exactly
 *   as it would on mainnet, and runs again once the makers hold real-code tokens (their
 *   inventory and bonds);
 * - the services start with HUSHD_NETWORK=mainnet (relayer, API, indexer from the node's
 *   own RPC, matcher, three makers, keeper), on their own ports beside any other stack;
 * - an agent drives the MCP server's tools the way an AI agent would: shield, a private
 *   send to a second agent, a spot trade per pair matched and settled privately, a cash
 *   out, a payment proof checked by the pool, and a private x402 payment to a maker.
 *
 * Two things a sandbox cannot hold are stood in for, and said so: the matcher enclave
 * runs as a local process (no TEE: `services/src/matcher.ts` localEnclave), and OutLayer
 * and the MPC signer are the test doubles from contracts/sandbox-tests. Hedged deals,
 * which trade on Hyperliquid mainnet, are not run here.
 *
 * Needs: the reproducible contract wasm (contracts/target/near), the doubles
 * (`cargo near build non-reproducible-wasm` in contracts/sandbox-tests/doubles/*), a native
 * matcher (`cargo build --release --target <host>` in matcher/), Postgres on localhost and
 * the circuits in app/public/circuits. Ports 9080 and 9787-9792; database hushd_sandbox.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { createAgent, createServer } from "@hushd/mcp";
import { MAINNET, MAINNET_USDC, tokenInfo, type MarketCandles, type MarketMids, type ProofKind } from "@hushd/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Near } from "near-kit";
import { Sandbox, type StateRecord } from "near-kit/sandbox";
import { mids as hlMids, minReceiveAt } from "../src/market.js";
import { deployHushd } from "./deploy.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const DATA = join(ROOT, "services/data/mainnet-sandbox");
const CODE = join(ROOT, "services/data/mainnet-code");
const NEAR = 10n ** 24n;
const GATEWAY = 9080;
const PORT_BASE = 9787;
const DB = "hushd_sandbox";
const HOST = execFileSync("rustc", ["-vV"]).toString().match(/host: (\S+)/)![1]!;
const MATCHER_BIN = join(ROOT, "matcher/target", HOST, "release/hushd-matcher");

const BTC = "nbtc.bridge.near";
const WNEAR = "wrap.near";
const USDC = MAINNET_USDC;
/** The sandbox's own operator for the real tokens' admin roles (USDC roles, the BTC controller). */
const OPERATOR = "token-operator.near";
const OPERATOR_2 = "token-operator-2.near";
const DEPLOYER = "hushd.near";
const TRADER = "trader.near";

const step = (s: string) => console.log(`\n- ${s}`);
const results: { check: string; ok: boolean; detail: string }[] = [];
const pass = (check: string, detail = "") => {
  results.push({ check, ok: true, detail });
  console.log(`  PASS  ${check}${detail ? `: ${detail}` : ""}`);
};

function keypair() {
  const secret = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(secret);
  return { publicKey: `ed25519:${base58.encode(pub)}`, privateKey: `ed25519:${base58.encode(new Uint8Array([...secret, ...pub]))}` as `ed25519:${string}` };
}

/** The code at a mainnet account, checked against mainnet's code hash and cached. */
async function mainnetCode(account: string): Promise<Uint8Array> {
  const r = (await fetch(MAINNET.rpc[0]!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }),
  }).then((x) => x.json())) as { result: { code_hash: string } };
  const path = join(CODE, `${account}.wasm`);
  if (!existsSync(path) || base58.encode(createHash("sha256").update(readFileSync(path)).digest()) !== r.result.code_hash) {
    const c = (await fetch(MAINNET.rpc[0]!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_code", finality: "final", account_id: account } }),
    }).then((x) => x.json())) as { result: { code_base64: string } };
    mkdirSync(CODE, { recursive: true });
    writeFileSync(path, Buffer.from(c.result.code_base64, "base64"));
  }
  const code = new Uint8Array(readFileSync(path));
  assert.equal(base58.encode(createHash("sha256").update(code).digest()), r.result.code_hash, `${account}: cached code is not mainnet's`);
  return code;
}

/** An account with this id, balance, one full-access key and optionally code, written straight into the node's state. */
function accountRecords(id: string, nearAmount: bigint, publicKey: string, code?: Uint8Array): StateRecord[] {
  const codeHash = code ? base58.encode(createHash("sha256").update(code).digest()) : "11111111111111111111111111111111";
  return [
    { Account: { account_id: id, account: { amount: (nearAmount * NEAR).toString(), locked: "0", code_hash: codeHash, storage_usage: (code?.length ?? 0) + 300 } } },
    { AccessKey: { account_id: id, public_key: publicKey, access_key: { nonce: 0, permission: "FullAccess" } } },
    ...(code ? [{ Contract: { account_id: id, code: Buffer.from(code).toString("base64") } }] : []),
  ];
}

const wasm = (path: string) => new Uint8Array(readFileSync(join(ROOT, path)));

async function main() {
  for (const [p, how] of [
    ["contracts/target/near/hushd_pool/hushd_pool.wasm", "cargo near build reproducible-wasm in contracts/pool, desk and board"],
    ["contracts/target/near/outlayer_double/outlayer_double.wasm", "cargo near build non-reproducible-wasm in contracts/sandbox-tests/doubles/outlayer"],
    ["contracts/target/near/mpc_double/mpc_double.wasm", "cargo near build non-reproducible-wasm in contracts/sandbox-tests/doubles/mpc"],
  ] as const) if (!existsSync(join(ROOT, p))) throw new Error(`${p} is missing: ${how}`);
  if (!existsSync(MATCHER_BIN)) throw new Error(`${MATCHER_BIN} is missing: cargo build --release --target ${HOST} in matcher/`);
  rmSync(DATA, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });

  step("the real mainnet code Hushd depends on");
  const real = { [USDC]: await mainnetCode(USDC), [WNEAR]: await mainnetCode(WNEAR), [BTC]: await mainnetCode(BTC) };
  for (const [id, code] of Object.entries(real)) console.log(`  ${id}: ${code.length} bytes, same hash as on mainnet`);

  step("a local node at nearcore 2.14.0, the version mainnet runs");
  const sandbox = await Sandbox.start({ version: "2.14.0", detached: false, ...(process.env.NEAR_SANDBOX_BIN_PATH ? { binaryPath: process.env.NEAR_SANDBOX_BIN_PATH } : {}) });
  const rpc = sandbox.rpcUrl;
  const children: ChildProcess[] = [];
  const stop = async () => {
    for (const c of children) c.kill("SIGTERM");
    await sandbox.stop();
  };
  try {
    const key = keypair();
    const as = (id: string, k: `ed25519:${string}` = key.privateKey) => new Near({ network: { networkId: "mainnet", rpcUrl: rpc }, privateKey: k, defaultSignerId: id, defaultWaitUntil: "FINAL" });
    const call = (id: string, contract: string, method: string, args: object, deposit = 0n, gas = "100 Tgas", k?: `ed25519:${string}`) =>
      as(id, k).transaction(id).functionCall(contract, method, args, { gas: gas as `${number} Tgas`, attachedDeposit: deposit }).send();
    const viewOf = async <T>(contract: string, method: string, args: object = {}) => (await as(DEPLOYER).view(contract, method, args)) as T;

    // matcher keys: the double hands the desk the local matcher's public keys, as OutLayer would the enclave's
    const matcherSeed = randomBytes(32).toString("hex");
    const pubkeys = JSON.parse(execFileSync(MATCHER_BIN, { input: JSON.stringify({ cmd: "pubkey" }), env: { PROTECTED_MATCHER_KEY: matcherSeed } }).toString()) as { sign_key: string; enc_key: string };

    await sandbox.patchState([
      ...accountRecords(USDC, 50n, key.publicKey, real[USDC]),
      ...accountRecords(WNEAR, 50n, key.publicKey, real[WNEAR]),
      ...accountRecords(BTC, 50n, key.publicKey, real[BTC]),
      ...accountRecords("outlayer.near", 50n, key.publicKey, wasm("contracts/target/near/outlayer_double/outlayer_double.wasm")),
      ...accountRecords("v1.signer", 50n, key.publicKey, wasm("contracts/target/near/mpc_double/mpc_double.wasm")),
      ...accountRecords(OPERATOR, 100n, key.publicKey),
      ...accountRecords(OPERATOR_2, 100n, key.publicKey),
      ...accountRecords(DEPLOYER, 5_000n, key.publicKey),
      ...accountRecords(TRADER, 100n, key.publicKey),
    ]);
    await new Promise((r) => setTimeout(r, 2_000));
    pass("mainnet accounts exist on the node with mainnet's code", `${USDC.slice(0, 8)}… (USDC), ${WNEAR}, ${BTC}; doubles at outlayer.near and v1.signer`);

    step("initialise the real token code and its admin roles");
    const usdcMeta = { spec: "ft-1.0.0", name: "USDC", symbol: "USDC", icon: null, reference: null, reference_hash: null, decimals: 6 };
    await call(USDC, USDC, "init", { admin_ids: [OPERATOR, OPERATOR_2], master_minter_ids: [OPERATOR, OPERATOR_2], owner_ids: [OPERATOR, OPERATOR_2], pauser_ids: [OPERATOR], blocklister_id: OPERATOR, metadata: usdcMeta });
    await usdcMinter(call, viewOf);
    await call(WNEAR, WNEAR, "new", {});
    await call(BTC, BTC, "new", { controller: OPERATOR, bridge_id: OPERATOR, name: "Near WBTC", symbol: "NBTC", icon: null, decimals: 8 });
    for (const t of [USDC, WNEAR, BTC]) {
      const m = await viewOf<{ symbol: string; decimals: number }>(t, "ft_metadata");
      console.log(`  ${t.slice(0, 24)}: ${m.symbol}, ${m.decimals} decimals`);
    }

    /** Real-code tokens to an account: register its storage, then mint (USDC, BTC) or wrap (wNEAR, from the account's own NEAR). */
    const fund = async (acc: string, k: `ed25519:${string}`, amounts: { usdc?: bigint; wnear?: bigint; btc?: bigint }) => {
      for (const t of [USDC, WNEAR, BTC]) {
        if ((await viewOf<unknown>(t, "storage_balance_of", { account_id: acc })) === null) {
          const min = (await viewOf<{ min: string }>(t, "storage_balance_bounds")).min;
          await call(OPERATOR, t, "storage_deposit", { account_id: acc, registration_only: true }, BigInt(min), "30 Tgas");
        }
      }
      if (amounts.usdc) await call(OPERATOR, USDC, "mint", { to: acc, amount: amounts.usdc.toString() }, 0n, "30 Tgas");
      if (amounts.btc) await call(OPERATOR, BTC, "mint", { mint_account_id: acc, mint_amount: amounts.btc.toString(), protocol_fee: "0", relayer_account_id: OPERATOR, relayer_fee: "0", post_actions: null }, 0n, "100 Tgas");
      if (amounts.wnear) await call(acc, WNEAR, "near_deposit", {}, amounts.wnear, "30 Tgas", k);
    };

    step("deploy Hushd with the MAINNET profile (scripts/deploy.ts), as hushd.near");
    const envPath = join(DATA, "deploy.env");
    const before = Number(await as(DEPLOYER).getBalance(DEPLOYER));
    const first = await deployHushd({ network: "mainnet", rpc: [rpc], deployerKey: key.privateKey, envPath, reportPath: join(DATA, "deployment.json"), log: (s) => console.log(`  ${s}`) });
    const net = first.net;
    assert.equal(net.pool, MAINNET.pool);
    assert.equal(net.desk, MAINNET.desk);
    pass("the mainnet deploy ran", `${Object.values(first.report.contracts).map((c) => c.account).join(", ")} with the reproducible wasm`);

    step("makers bring real-code tokens; the deploy runs again and shields them and posts their bonds");
    for (const m of ["MAKER_A", "MAKER_B", "MAKER_C"]) {
      const acc = first.env[`${m}_ACCOUNT`]!;
      await as(DEPLOYER).transaction(DEPLOYER).transfer(acc, 520n * NEAR).send();
      await fund(acc, first.env[`${m}_PRIVATE_KEY`] as `ed25519:${string}`, { usdc: 3_000n * 10n ** 6n, wnear: 500n * NEAR, btc: 2_000_000n });
    }
    const second = await deployHushd({ network: "mainnet", rpc: [rpc], deployerKey: key.privateKey, envPath, reportPath: join(DATA, "deployment.json"), log: (s) => console.log(`  ${s}`) });
    const makers = await viewOf<[string, { bond: string; active: boolean }][]>(net.desk!, "makers", {});
    assert.equal(makers.length, 3);
    for (const [acc, m] of makers) assert.equal(BigInt(m.bond), 1_000n * 10n ** 6n, `${acc} bond`);
    pass("three makers are registered and bonded in real-code USDC", makers.map(([acc, m]) => `${acc} ${Number(BigInt(m.bond)) / 1e6} USDC`).join(", "));
    // the 3 x 520 NEAR handed to the makers (their wNEAR and gas) is theirs, not the deploy's
    const spent = before - Number(await as(DEPLOYER).getBalance(DEPLOYER)) - 3 * 520;
    pass("the deploy's cost in NEAR, as mainnet would charge it", `${spent.toFixed(2)} NEAR for accounts, contract storage and gas (the deploy script plans 28)`);

    step("the desk takes the matcher's keys through OutLayer (the double)");
    await call(DEPLOYER, "outlayer.near", "new", { sign_key: pubkeys.sign_key, enc_key: pubkeys.enc_key });
    await call(DEPLOYER, net.desk!, "refresh_enclave_key", {}, 10n ** 23n, "300 Tgas");
    const enclave = await viewOf<{ sign_key: string | null; enc_key: string | null }>(net.desk!, "enclave");
    assert.equal(enclave.sign_key, pubkeys.sign_key);
    await call(DEPLOYER, "v1.signer", "new", {});
    pass("the desk holds the matcher's signing and sealing keys", `${pubkeys.sign_key.slice(0, 18)}…`);

    step("the services on HUSHD_NETWORK=mainnet");
    execFileSync("dropdb", ["--if-exists", DB]);
    execFileSync("createdb", [DB]);
    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(second.env).filter(([k]) => /^(RELAYER|MATCHER|KEEPER|MAKER_[ABC])_/.test(k))),
      HUSHD_NETWORK: "mainnet",
      NEAR_RPC_URL: rpc,
      HUSHD_API_URL: `http://localhost:${GATEWAY}`,
      MAKERS_PUBLIC_URL: `http://localhost:${GATEWAY}`,
      RELAYER_URL: `http://localhost:${PORT_BASE}`,
      API_URL: `http://localhost:${PORT_BASE + 1}`,
      DATABASE_URL: `postgres://localhost:5432/${DB}`,
      INDEXER_SOURCE: "rpc",
      MATCHER_LOCAL_BIN: MATCHER_BIN,
      MATCHER_LOCAL_KEY: matcherSeed,
      MAKERS_DATA_DIR: join(DATA, "makers"),
      KEEPER_POLL_MS: "2000",
    };
    const envFile = join(DATA, "services.env");
    writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
    const stack = spawn(process.execPath, ["--import", "tsx", "scripts/stack.ts"], {
      cwd: join(ROOT, "services"),
      // only the sandbox's settings: nothing from the repo's .env (its keys are testnet's)
      env: { PATH: process.env.PATH!, HOME: process.env.HOME!, USER: process.env.USER ?? "", HUSHD_ENV_FILE: envFile, STACK_SERVICES: "api,relayer,indexer,matcher,makers,keeper", STACK_PORT_BASE: String(PORT_BASE), GATEWAY_PORT: String(GATEWAY) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(stack);
    const log = join(DATA, "services.log");
    writeFileSync(log, "");
    for (const s of [stack.stdout!, stack.stderr!]) s.on("data", (b: Buffer) => writeFileSync(log, b, { flag: "a" }));
    await waitFor(async () => {
      for (const s of ["relayer", "api", "indexer", "matcher", "makers", "keeper"]) {
        const r = await fetch(`http://localhost:${GATEWAY}/health/${s}`).catch(() => null);
        if (!r?.ok) return false;
      }
      return true;
    }, 120_000, "the services to answer /health");
    const relayerInfo = (await (await fetch(`http://localhost:${GATEWAY}/v1/relay/info`)).json()) as { network: string; cashOutFeeBps: number };
    assert.equal(relayerInfo.network, "mainnet");
    pass("relayer, API, indexer, matcher, makers and keeper run on mainnet settings", `relayer fee ${relayerInfo.cashOutFeeBps} bps on cash outs`);
    // the trading screen's prices: Hyperliquid mainnet through the API, for the mainnet tokens' hedge coins
    const mids = (await (await fetch(`http://localhost:${GATEWAY}/v1/market/mids`)).json()) as MarketMids;
    assert.deepEqual(Object.keys(mids.mids).sort(), ["BTC", "NEAR"]);
    const candles = (await (await fetch(`http://localhost:${GATEWAY}/v1/market/candles?coin=BTC&interval=5m&limit=50`)).json()) as MarketCandles;
    assert.equal(candles.candles.length, 50);
    assert.ok(candles.candles.every((c) => c.c > 0));
    pass("the API serves the trading screen's prices on mainnet settings", `BTC ${mids.mids.BTC} USD, NEAR ${mids.mids.NEAR} USD, 50 five-minute BTC candles`);

    step("an agent, through the MCP server's tools");
    const traderKey = key.privateKey;
    await fund(TRADER, traderKey, { usdc: 5_000n * 10n ** 6n, wnear: 20n * NEAR, btc: 0n });
    const agentEnv = (home: string, withAccount: boolean) => ({
      HUSHD_NETWORK: "mainnet",
      HUSHD_RPC_URL: rpc,
      HUSHD_API_URL: `http://localhost:${GATEWAY}`,
      HUSHD_HOME: join(DATA, home),
      HUSHD_CIRCUITS_DIR: join(ROOT, "app/public/circuits"),
      HUSHD_LIMIT_PER_PAYMENT: "USDC=5000,wNEAR=50,BTC=1",
      HUSHD_LIMIT_PER_DAY: "USDC=10000,wNEAR=100,BTC=1",
      ...(withAccount ? { HUSHD_NEAR_ACCOUNT: TRADER, HUSHD_NEAR_PRIVATE_KEY: traderKey } : {}),
    });
    const agent = await createAgent(agentEnv("agent", true), randomBytes(32));
    const friend = await createAgent(agentEnv("friend", false), randomBytes(32));
    assert.equal(agent.net.id, "mainnet");
    assert.equal(agent.net.pool, "pool.hushd.near");
    const vkey = async (k: ProofKind) => JSON.parse(readFileSync(join(ROOT, "app/public/circuits", `${k}.vkey.json`), "utf8"));
    const server = createServer({ net: agent.net, vkey, agent, verifyBase: "http://localhost:3000/verify" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "mainnet-sandbox", version: "1" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
      const text = (r.content as { text: string }[])[0]?.text ?? "";
      console.log(`  ${r.isError ? "x" : "+"} ${name} ${JSON.stringify(args)}\n    ${text.slice(0, 400).replace(/\n/g, "\n    ")}`);
      if (r.isError) throw new Error(`${name} failed: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    };

    const faucet = await client.callTool({ name: "hushd_faucet", arguments: { token: "USDC" } });
    assert.ok(faucet.isError, "the faucet must refuse on mainnet");
    pass("the faucet tool refuses on mainnet");

    await tool("hushd_shield", { token: "USDC", amount: "3000" });
    await tool("hushd_shield", { token: "wNEAR", amount: "10" });
    const bal = await tool("hushd_balance");
    pass("tokens shielded from a NEAR account into the pool", JSON.stringify(bal.balances ?? bal));

    await tool("hushd_send", { to: friend.id.address, token: "USDC", amount: "25", memo: "invoice 7" });
    await friend.wallet.sync();
    assert.equal(friend.wallet.balances().get(USDC), 25_000_000n);
    pass("a private send reached the second agent", "25 USDC, found by trial decryption on the board");

    // each floor: the mid price less 3%, the least the agent accepts
    const floor = async (sell: string, amount: number, buy: string) => minReceiveAt(await hlMids(), tokenInfo(MAINNET, sell), amount, tokenInfo(MAINNET, buy));
    const spot = await tool("hushd_trade", { kind: "spot", sell_token: "USDC", sell_amount: "1000", buy_token: "wNEAR", min_receive: await floor("USDC", 1000, "wNEAR"), window_seconds: 15 });
    // a finished deal is closed, and its receipt carries the outcome
    const settled = async (dealId: number) => {
      const d = await viewOf<{ status: string; receipt: { outcome: string } | null }>(net.desk!, "deal", { deal_id: String(dealId) });
      return `${d.status}/${d.receipt?.outcome}`;
    };
    assert.equal(await settled(spot.deal_id as number), "closed/settled");
    pass("a spot trade matched in the sealed auction and settled privately", `deal ${spot.deal_id} with ${spot.maker}: gave ${spot.gave}, got ${spot.got}`);
    const btcTrade = await tool("hushd_trade", { kind: "spot", sell_token: "wNEAR", sell_amount: "5", buy_token: "BTC", min_receive: await floor("wNEAR", 5, "BTC"), window_seconds: 15 });
    assert.equal(await settled(btcTrade.deal_id as number), "closed/settled");
    pass("a wNEAR to BTC trade settled in real-code nBTC", `deal ${btcTrade.deal_id}: gave ${btcTrade.gave}, got ${btcTrade.got}`);

    const wnearBefore = BigInt(await viewOf<string>(WNEAR, "ft_balance_of", { account_id: TRADER }));
    await tool("hushd_cash_out", { token: "wNEAR", amount: "2", to_account: TRADER });
    const wnearAfter = BigInt(await viewOf<string>(WNEAR, "ft_balance_of", { account_id: TRADER }));
    const fee = (2n * NEAR * BigInt(relayerInfo.cashOutFeeBps)) / 10_000n;
    assert.equal(wnearAfter - wnearBefore, 2n * NEAR - fee);
    pass("a cash out paid real-code wNEAR to a NEAR account", `received ${Number((wnearAfter - wnearBefore) / 10n ** 21n) / 1000} wNEAR after the relayer's ${relayerInfo.cashOutFeeBps} bps`);

    const proof = await tool("hushd_prove", { what: "payment", reader: "auditor.near" });
    const verdict = await tool("hushd_verify_proof", { proof: proof.proof, as_reader: "auditor.near" });
    assert.equal(verdict.holds, true, JSON.stringify(verdict));
    pass("a payment proof for one named reader checks out on chain", "pool.verify_disclosure");

    const x402 = await tool("hushd_pay_x402", { url: `http://localhost:${GATEWAY}/makers/steady/quote?sell=${USDC}&amount=100000000&buy=${WNEAR}` });
    assert.equal(x402.status, 200, JSON.stringify(x402));
    pass("a private x402 payment bought a maker's quote", `paid ${JSON.stringify((x402.paid as { amount: string }).amount)}`);

    step("the deployment after the run");
    const deals = await tool("hushd_desk_deals");
    const stats = await viewOf<Record<string, number>>(net.pool!, "stats");
    const relayer = second.env.RELAYER_ACCOUNT!;
    for (const t of [USDC, WNEAR, BTC]) {
      const balance = BigInt(await viewOf<string>(t, "ft_balance_of", { account_id: net.pool! }));
      const asset = (await viewOf<{ token: string; held: string }[]>(net.pool!, "assets")).find((x) => x.token === t);
      const unclaimed = BigInt(await viewOf<string>(net.pool!, "unclaimed", { account: relayer, token: t }));
      assert.equal(BigInt(asset!.held) + unclaimed, balance, `${t}: the pool's notes plus what waits to be claimed, against its token balance`);
      assert.equal(unclaimed, 0n, `${t}: a relayer fee the pool could not pay`);
    }
    assert.equal(BigInt(await viewOf<string>(WNEAR, "ft_balance_of", { account_id: relayer })), fee, "the relayer's cash-out fee");
    pass("the pool's books match its real-code token balances, and the relayer was paid its fee", `stats ${JSON.stringify(stats)}`);
    const indexed = async () => ((await (await fetch(`http://localhost:${GATEWAY}/v1/events?contract=${net.desk}&limit=500`)).json()) as unknown[]).length;
    await waitFor(async () => (await indexed()) > 0, 60_000, "the indexer to store the desk's events");
    pass("the indexer read the node's own blocks", `${await indexed()} desk events stored; ${JSON.stringify(deals).length} bytes of deal records from hushd_desk_deals`);

    console.log(`\n${results.filter((r) => r.ok).length} of ${results.length} checks passed on Hushd's mainnet build in a sandbox. Services log: ${log}`);
  } finally {
    await stop();
  }
}

/**
 * USDC's roles, as Circle runs them: master minters name controllers for a minter, the
 * controllers give it an allowance, and every change is a multisig request two of them approve.
 */
async function usdcMinter(call: (id: string, c: string, m: string, a: object, d?: bigint, g?: string) => Promise<unknown>, viewOf: <T>(c: string, m: string, a?: object) => Promise<T>) {
  const request = async (action: object, approvers: string[]) => {
    const id = await viewOf<number>(USDC, "get_next_multisig_request_id");
    await call(approvers[0]!, USDC, "create_multisig_request", { action }, 0n, "50 Tgas");
    for (const a of approvers) await call(a, USDC, "approve_multisig_request", { request_id: id }, 0n, "50 Tgas");
    await call(approvers[0]!, USDC, "execute_multisig_request", { request_id: id }, 0n, "50 Tgas");
  };
  for (const c of [OPERATOR, OPERATOR_2]) await request({ ConfigureController: { controller_id: c, minter_id: OPERATOR } }, [OPERATOR, OPERATOR_2]);
  await request({ ConfigureMinterAllowance: { controller_id: OPERATOR, minter_allowance: (10n ** 15n).toString() } }, [OPERATOR, OPERATOR_2]);
  assert.ok(await viewOf<boolean>(USDC, "is_minter", { account_id: OPERATOR }));
}

async function waitFor(check: () => Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`timed out waiting for ${what}`);
}

main().then(
  () => process.exit(results.every((r) => r.ok) ? 0 : 1),
  (e) => {
    console.error(`\nFAIL: ${(e as Error).stack ?? e}`);
    process.exit(1);
  },
);
