/**
 * Is the hedge leg ready? With no flag, checks everything a hedged package uses on
 * Hyperliquid testnet without moving funds; with --run, trades one end to end once a maker
 * has margin and prints its receipt.
 *
 *   pnpm --filter @hushd/services exec tsx scripts/hedge-check.ts        # readiness
 *   pnpm --filter @hushd/services exec tsx scripts/hedge-check.ts --run  # a hedged trade, then its receipt
 *
 * Readiness: each maker's Hyperliquid key, address and margin; the margin one hedge of the
 * run's size needs; the coins the desk hedges are listed on Hyperliquid testnet; the desk's
 * MPC derives the next deal's address (Chain Signatures); and Hyperliquid takes the maker's
 * EIP-712 signature: an approveAgent for that address, signed by maker A, is either approved
 * or refused naming maker A itself (Hyperliquid recovers the signer, so a bad signature would
 * name some other address).
 *
 * --run uses the demo agent (DEMO_AGENT_SEED, DEMO_AGENT_POLICY_WALLET_KEY in .env) and the
 * services on localhost:8080, and writes the result to deployments/testnet-hedge.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgent, createServer } from "@hushd/mcp";
import { deskView, keepRpcErrorBodies, sendEndpoints, TESTNET, type ProofKind } from "@hushd/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Near } from "near-kit";
import { addressOfKey, approveDealAgent, dealAddress } from "../src/hyperliquid.js";
import { hedgeMargin } from "../src/makers.js";
import { hedgePerps, hedgeWithdrawable, mids } from "../src/market.js";

const ROOT = new URL("../..", import.meta.url).pathname;
process.loadEnvFile(join(ROOT, ".env"));
const API = process.env.DEMO_API_URL ?? "http://localhost:8080";
const net = TESTNET;
// the run's size: 2,000 USDC for wNEAR, hedged by a NEAR short (a bond of the desk's minimum step)
const RUN = { sellUsdc: 2_000, coin: "NEAR" };

const ok = (s: string) => console.log(`PASS  ${s}`);
const no = (s: string) => console.log(`WAIT  ${s}`);
const bad = (s: string) => {
  console.log(`FAIL  ${s}`);
  process.exitCode = 1;
};

async function readiness(): Promise<{ funded: string | null }> {
  const makers = ["A", "B", "C"].flatMap((m) => {
    const key = process.env[`MAKER_${m}_HL_KEY`];
    return key ? [{ name: `maker ${m}`, key, address: addressOfKey(key) }] : [];
  });
  if (makers.length === 3) ok(`every maker has a Hyperliquid key: ${makers.map((m) => `${m.name} ${m.address}`).join(", ")}`);
  else bad(`Hyperliquid keys for ${makers.length} of 3 makers (MAKER_A_HL_KEY, MAKER_B_HL_KEY, MAKER_C_HL_KEY in .env)`);

  const perps = await hedgePerps();
  const price = (await mids())[RUN.coin];
  const missing = ["NEAR", "BTC"].filter((c) => !perps[c]);
  if (missing.length === 0 && price) ok(`Hyperliquid testnet lists the hedged coins (NEAR as asset ${perps.NEAR!.asset}, BTC as asset ${perps.BTC!.asset}); NEAR is at ${price} USD`);
  else bad(`Hyperliquid testnet does not list ${missing.join(", ") || "a price for NEAR"}`);

  const need = hedgeMargin(RUN.sellUsdc, perps[RUN.coin]?.maxLeverage ?? 1);
  const margins = await Promise.all(makers.map((m) => hedgeWithdrawable(m.address)));
  const funded = makers.find((_, i) => margins[i]! >= need) ?? null;
  const line = makers.map((m, i) => `${m.name} ${margins[i]!.toFixed(2)}`).join(", ");
  if (funded) ok(`${funded.name} has the margin a ${RUN.sellUsdc} USDC hedge needs (${need.toFixed(0)} USDC): ${line}`);
  else no(`no maker has the ${need.toFixed(0)} USDC of margin a ${RUN.sellUsdc} USDC hedge needs yet (${line} USDC); fund one on Hyperliquid testnet`);

  // deal ids count from 0, so the next one is the number of deals so far
  const nextId = Number((await deskView.stats(net)).deals);
  const agent = await dealAddress(net, nextId);
  if (/^0x[0-9a-f]{40}$/.test(agent)) ok(`the desk's MPC derives the next deal's Hyperliquid address (deal ${nextId}: ${agent}, path hushd/hedge/${nextId})`);
  else bad(`the MPC answered an unreadable key for deal ${nextId}`);

  // a past hedge order: Hyperliquid names the wallet it recovered from the MPC's signature
  const past = (await deskView.deals(net, 100)).filter((d) => d.class === "bonded_hedge" && d.receipt);
  const named = past.flatMap((d) => (d.receipt!.evidence ?? []).map((e) => ({ id: d.id, m: /Wallet (0x[0-9a-fA-F]{40})/.exec(e.reference) })).filter((x) => x.m));
  if (named[0]) {
    const want = await dealAddress(net, named[0].id);
    if (named[0].m![1]!.toLowerCase() === want) ok(`deal ${named[0].id}'s order, signed by the MPC, recovered on Hyperliquid to that deal's own derived address (${want})`);
    else bad(`deal ${named[0].id}'s order recovered to ${named[0].m![1]}, not its derived address ${want}`);
  } else if (past.some((d) => d.receipt!.outcome === "settled")) ok("a past hedge order filled on Hyperliquid testnet");

  const a = makers[0];
  if (a) {
    try {
      await approveDealAgent(a.key, agent, true);
      ok(`Hyperliquid approved deal ${nextId}'s address as ${a.name}'s agent: the maker's EIP-712 signature checks out`);
    } catch (e) {
      const said = (e as Error).message;
      if (said.toLowerCase().includes(a.address.toLowerCase())) ok(`Hyperliquid read ${a.name}'s own address from its signature and refused only for the account's state: ${said}`);
      else if (/deposit|does not exist|unknown user|not found/i.test(said)) ok(`Hyperliquid took ${a.name}'s signature and refused for the account's state (no funds yet): ${said}`);
      else bad(`Hyperliquid refused ${a.name}'s signature: ${said}`);
    }
  }
  return { funded: funded?.name ?? null };
}

async function run() {
  const key = process.env.DEMO_AGENT_POLICY_WALLET_KEY;
  const seed = process.env.DEMO_AGENT_SEED;
  if (!key || !seed) throw new Error("the run uses the demo agent: DEMO_AGENT_POLICY_WALLET_KEY and DEMO_AGENT_SEED in .env");
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
  const agent = await createAgent(env, Uint8Array.from(Buffer.from(seed, "hex")));
  const vkey = async (k: ProofKind) => JSON.parse(readFileSync(join(ROOT, "app/public/circuits", `${k}.vkey.json`), "utf8"));
  const server = createServer({ net: agent.net, vkey, agent, verifyBase: "http://localhost:3000/verify" });
  const [x, y] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "hedge-check", version: "1" });
  await Promise.all([server.connect(x), client.connect(y)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    const text = (r.content as { text: string }[])[0]?.text ?? "";
    console.log(`${r.isError ? "x" : "+"} ${name} ${JSON.stringify(args)}\n${text.slice(0, 800)}`);
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };

  // test USDC for the trade: the token's owner mints it to the agent's account
  const account = ((await call("hushd_address")) as { near_account?: string }).near_account;
  if (account) {
    const deployer = process.env.DEPLOYER_ACCOUNT ?? "hushd.testnet";
    const dk = (JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${deployer}.json`), "utf8")) as { private_key: string }).private_key;
    keepRpcErrorBodies(net.rpc);
    const near = new Near({ network: { networkId: "testnet", rpcUrl: sendEndpoints(net)[0]! }, privateKey: dk as `ed25519:${string}`, defaultSignerId: deployer, defaultWaitUntil: "FINAL" });
    await near.transaction(deployer).functionCall(net.tokens[0]!.id, "mint", { account_id: account, amount: String((RUN.sellUsdc + 100) * 1e6) }, { gas: "30 Tgas" }).send();
    await call("hushd_shield", { token: "USDC", amount: String(RUN.sellUsdc + 50) });
  }
  const trade = (await call("hushd_trade", { kind: "spot_hedge", sell_token: "USDC", sell_amount: String(RUN.sellUsdc), buy_token: "wNEAR", window_seconds: 30 })) as { deal_id?: string | number };
  const dealId = Number(trade.deal_id);
  console.log(`deal ${dealId} settled its spot legs; the keeper now runs the hedge leg`);
  const start = Date.now();
  let deal = await deskView.deal(net, dealId);
  while (deal && deal.status !== "closed" && Date.now() - start < 30 * 60_000) {
    await new Promise((r) => setTimeout(r, 10_000));
    deal = await deskView.deal(net, dealId);
  }
  await client.close();
  if (!deal?.receipt) throw new Error(`deal ${dealId} has no receipt after 30 minutes`);
  const record = { dealId, maker: deal.maker, hedge: deal.hedge, receipt: deal.receipt, checkedAt: new Date().toISOString() };
  writeFileSync(join(ROOT, "deployments/testnet-hedge.json"), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify(record, null, 2));
  if (deal.receipt.outcome === "settled") ok(`deal ${dealId}: the hedge filled on Hyperliquid testnet and the bond was released`);
  else bad(`deal ${dealId} ended ${deal.receipt.outcome}`);
}

const { funded } = await readiness();
if (process.argv.includes("--run")) {
  if (!funded) {
    bad("--run needs a maker with Hyperliquid margin first");
    process.exit(1);
  }
  await run();
}
process.exit(process.exitCode ?? 0);
