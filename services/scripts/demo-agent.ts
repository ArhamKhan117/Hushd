/**
 * A demo agent on testnet: drives the real MCP server's wallet tools in-process, the way
 * an AI agent would, through every flow once, and prints what happened with links.
 *
 *   pnpm --filter @hushd/services exec tsx scripts/demo-agent.ts
 *
 * The agent's NEAR account is an OutLayer policy wallet (DEMO_AGENT_POLICY_WALLET_KEY in
 * .env, made with `scripts/policy-wallet.ts create DEMO_AGENT`): it holds no NEAR key, and
 * the run shows the TEE refusing a call outside the owner's policy and the owner's freeze
 * stopping the agent. Needs the services running (`pnpm stack`), DEMO_AGENT_SEED (64 hex,
 * made when missing) and the deployer key in ~/.near-credentials to mint test USDC.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgent, createServer } from "@hushd/mcp";
import { CUSTODY, CustodyWallet, PolicyRefusal, type ProofKind } from "@hushd/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Near } from "near-kit";

const ROOT = new URL("../..", import.meta.url).pathname;
process.loadEnvFile(join(ROOT, ".env"));
const API = process.env.DEMO_API_URL ?? "http://localhost:8080";
const DEPLOYER = process.env.DEPLOYER_ACCOUNT ?? "hushd.testnet";
const rpcUrl = "https://test.rpc.fastnear.com";

function remember(k: string, v: string) {
  appendFileSync(join(ROOT, ".env"), `${k}=${v}\n`);
  process.env[k] = v;
}

async function ensureAgentAccount() {
  if (!process.env.DEMO_AGENT_SEED) remember("DEMO_AGENT_SEED", randomBytes(32).toString("hex"));
  const key = process.env.DEMO_AGENT_POLICY_WALLET_KEY;
  if (!key) throw new Error("no policy wallet: run `tsx scripts/policy-wallet.ts create DEMO_AGENT` first");
  const id = (await new CustodyWallet(key, CUSTODY.testnet.api).address()).accountId;
  const deployerKey = (JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${DEPLOYER}.json`), "utf8")) as { private_key: string }).private_key;
  const deployer = new Near({ network: { networkId: "testnet", rpcUrl }, privateKey: deployerKey as `ed25519:${string}`, defaultSignerId: DEPLOYER, defaultWaitUntil: "FINAL" });
  // test USDC for the trades: the token's owner mints it (the faucet gives 10,000 an hour)
  await deployer.transaction(DEPLOYER).functionCall("usdc.hushd.testnet", "mint", { account_id: id, amount: "21000000000" }, { gas: "30 Tgas" }).send();
  return { id, key };
}

/** The owner freezes or unfreezes the agent's wallet (scripts/policy-wallet.ts). */
function owner(cmd: "freeze" | "unfreeze") {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/policy-wallet.ts", cmd, "DEMO_AGENT"], { cwd: join(ROOT, "services"), stdio: "inherit" });
}

async function main() {
  const { id: account, key } = await ensureAgentAccount();
  const env = {
    ...process.env,
    HUSHD_API_URL: API,
    HUSHD_HOME: join(ROOT, "services/data/demo-agent"),
    HUSHD_CIRCUITS_DIR: join(ROOT, "app/public/circuits"),
    HUSHD_POLICY_WALLET_KEY: key,
    HUSHD_NEAR_ACCOUNT: undefined,
    HUSHD_NEAR_PRIVATE_KEY: undefined,
    HUSHD_LIMIT_PER_PAYMENT: "USDC=12000,wNEAR=100",
    HUSHD_LIMIT_PER_DAY: "USDC=30000,wNEAR=500",
  };
  const agent = await createAgent(env, Uint8Array.from(Buffer.from(process.env.DEMO_AGENT_SEED!, "hex")));
  const vkey = async (k: ProofKind) => JSON.parse(readFileSync(join(ROOT, "app/public/circuits", `${k}.vkey.json`), "utf8"));
  const server = createServer({ net: agent.net, vkey, agent, verifyBase: "http://localhost:3000/verify" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "demo-agent", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    // a trade waits out the quote window, the match and both proofs: give tools ten minutes
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    console.log(`\n${r.isError ? "x" : "+"} ${name} ${JSON.stringify(args)}\n${text.slice(0, 600)}`);
    if (r.isError) throw new Error(`${name} failed`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  await call("hushd_address");
  await call("hushd_policy");
  await call("hushd_shield", { token: "USDC", amount: "20000" });
  // the TEE, not this script, refuses what the owner's policy does not allow
  await new CustodyWallet(key, CUSTODY.testnet.api)
    .call({ receiver: "wrap.testnet", method: "near_deposit", args: {}, gas: 30_000_000_000_000n, deposit: 10n ** 21n })
    .then(() => { throw new Error("the policy wallet signed a call outside its policy"); })
    .catch((e) => { if (!(e instanceof PolicyRefusal)) throw e; console.log(`\n+ policy wallet refused a call outside the policy (${e.code}): ${e.message}`); });
  owner("freeze");
  await new Promise((r) => setTimeout(r, 16_000));
  const frozen = await client.callTool({ name: "hushd_send", arguments: { to: (await call("hushd_address")).address, token: "USDC", amount: "1" } });
  console.log(`\n${frozen.isError ? "+ frozen: the agent may not spend" : "x the agent spent while frozen"}: ${(frozen.content as { text: string }[])[0]?.text}`);
  if (!frozen.isError) throw new Error("spent while frozen");
  owner("unfreeze");
  await new Promise((r) => setTimeout(r, 16_000));
  await new Promise((r) => setTimeout(r, 8_000));
  await call("hushd_balance");
  const makers = (await call("hushd_makers")) as unknown as { account: string; quote_url: string }[];
  const paid = await call("hushd_pay_x402", { url: `${API}/makers/${makers[0]!.account}/quote?sell=usdc.hushd.testnet&amount=500000000&buy=btc.hushd.testnet` });
  console.log("x402 paid:", JSON.stringify(paid.paid));
  await call("hushd_cash_out", { to_account: account, token: "USDC", amount: "10" });
  await call("hushd_balance");
  await call("hushd_trade", { kind: "spot", sell_token: "USDC", sell_amount: "500", buy_token: "BTC", window_seconds: 30 });
  await call("hushd_prove", { what: "payment", reader: "judge.testnet", days: 30 });
  await call("hushd_prove", { what: "funds", reader: "judge.testnet", days: 30, token: "USDC", threshold: "1000" });
  // a maker quotes a hedged package only with Hyperliquid testnet margin behind it
  await call("hushd_trade", { kind: "spot_hedge", sell_token: "USDC", sell_amount: "2000", buy_token: "wNEAR", window_seconds: 30 }).catch((e) => console.log(`\n= hedged trade not matched (${(e as Error).message}): no maker has Hyperliquid margin yet`));
  await call("hushd_my_deals");
  await client.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("demo-agent:", (e as Error).message);
  process.exit(1);
});
