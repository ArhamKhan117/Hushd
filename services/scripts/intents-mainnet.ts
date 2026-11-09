/**
 * Real NEAR Intents trades between two Hushd agents on mainnet, inside a 1 to 4 USD budget.
 *
 *   pnpm --filter @hushd/services intents:mainnet            # plan + dry run: costs, quotes, a simulated trade
 *   pnpm --filter @hushd/services intents:mainnet --execute  # run it (only with the owner's yes)
 *   pnpm --filter @hushd/services intents:mainnet --execute --again  # one more round, after a finished one
 *
 * Accounts (keys in the repo .env, made on the first run): a dev wallet the owner funds with
 * about 0.8 NEAR, and two agents, a trader and a maker, each an implicit account.
 *
 * What --execute does, in order (it resumes where it stopped, from services/data/intents-mainnet.json):
 *  1. the dev wallet funds the trader (0.4 NEAR) and the maker (0.35 NEAR)
 *  2. each agent wraps NEAR and deposits the wNEAR into intents.near
 *  3. the trader swaps 0.15 wNEAR for USDC through 1Click, from and to its Intents balance
 *     (confidential when ONECLICK_API_KEY, a partner key, is set)
 *  4. the trade: the trader gives its USDC for wNEAR at the maker's price (Hyperliquid mid
 *     less 25 bps); both sign a token_diff, the pair is simulated, the maker submits it
 *  5. both withdraw everything back to their own accounts
 *  6. both send everything back to the dev wallet (wNEAR unwrapped, USDC transferred)
 * Each step's transactions are written to deployments/mainnet-intents.json; with --again the
 * finished round moves to its `earlier` list and a new round starts on what came back. A round
 * spends about 0.03 NEAR and brings the 0.15 NEAR it swapped back as about 0.54 USDC, so a
 * second round needs about 0.16 NEAR more in the dev wallet (0.78 to start one).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { INTENTS_MAINNET as I, MAINNET, OneClick, mt, quoteRequest, verifierCalls, verifierView } from "@hushd/sdk";
import { IntentsAgent, executeSigned, signTrade } from "../src/intents-trade.js";
import { priceAsk } from "../src/makers.js";
import { mids } from "../src/market.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const ENV = join(ROOT, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);
const STATE = join(ROOT, "services/data/intents-mainnet.json");
const RECORD = join(ROOT, "deployments/mainnet-intents.json");
const EXECUTE = process.argv.includes("--execute");
const AGAIN = process.argv.includes("--again");

const NEAR = 10n ** 24n;
const milli = (n: number) => (BigInt(n) * NEAR) / 1000n;
const PLAN = { trader: milli(400), maker: milli(350), traderWrap: milli(300), makerWrap: milli(250), swapIn: milli(150), devFloor: milli(30) };
const fmt = (yocto: bigint, d = 24) => (Number(yocto) / 10 ** d).toFixed(d === 24 ? 4 : 6);

function secret(name: string): Uint8Array {
  if (!process.env[name]) {
    const hex = randomBytes(32).toString("hex");
    appendFileSync(ENV, `${name}=${hex}\n`);
    process.env[name] = hex;
  }
  return Uint8Array.from(Buffer.from(process.env[name]!, "hex"));
}

type Step = { step: string; txs: string[]; note?: string; at: string };
const state: { steps: Record<string, Step>; earlier?: Step[][] } = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { steps: {} };
function write() {
  mkdirSync(join(ROOT, "services/data"), { recursive: true });
  writeFileSync(STATE, JSON.stringify(state, null, 2));
  const earlier = state.earlier?.length ? { earlier: state.earlier } : {};
  writeFileSync(RECORD, `${JSON.stringify({ network: "mainnet", verifier: I.verifier, explorer: "https://nearblocks.io/txns/", steps: Object.values(state.steps), ...earlier }, null, 2)}\n`);
}
function save(step: string, txs: string[], note?: string) {
  state.steps[step] = { step, txs, ...(note ? { note } : {}), at: new Date().toISOString() };
  write();
}
const done = (s: string) => !!state.steps[s];

async function main() {
  const dev = new IntentsAgent(MAINNET, I.verifier, secret("INTENTS_DEV_SECRET"), "dev wallet");
  const trader = new IntentsAgent(MAINNET, I.verifier, secret("INTENTS_TRADER_SECRET"), "trader");
  const maker = new IntentsAgent(MAINNET, I.verifier, secret("INTENTS_MAKER_SECRET"), "maker");
  const oneClick = new OneClick(process.env.ONECLICK_URL ?? I.oneClick, process.env.ONECLICK_API_KEY || undefined);
  const nearUsd = (await mids()).NEAR!;
  const usd = (yocto: bigint) => `$${((Number(yocto) / 1e24) * nearUsd).toFixed(2)}`;

  console.log(`NEAR ${nearUsd} USD (Hyperliquid mid)`);
  console.log(`dev wallet ${dev.accountId}  (fund this with 0.8 NEAR, about ${usd(milli(800))})`);
  console.log(`trader     ${trader.accountId}`);
  console.log(`maker      ${maker.accountId}`);
  const [devNear, traderNear, makerNear] = await Promise.all([dev, trader, maker].map((a) => a.nearBalance()));
  const show = (b: bigint | null | undefined) => (b == null ? "no account yet" : fmt(b));
  console.log(`NEAR now: dev ${show(devNear)}, trader ${show(traderNear)}, maker ${show(makerNear)}`);

  console.log("\nPlan (gas about 0.001 NEAR per transaction):");
  const rows: [string, string][] = [
    ["1 dev wallet funds both agents (2 transfers)", `${fmt(PLAN.trader + PLAN.maker)} NEAR moved (${usd(PLAN.trader + PLAN.maker)}), gas ~0.002`],
    ["2 wrap + deposit into intents.near (6 calls)", `${fmt(PLAN.traderWrap + PLAN.makerWrap)} NEAR wrapped, storage 2 x 0.00125, gas ~0.006`],
    ["3 1Click swap 0.15 wNEAR to USDC (1 call)", "1Click fee on ~$0.56, gas ~0.003"],
    ["4 direct token_diff trade (1 call)", "verifier fee 0.0001%, gas ~0.003"],
    ["5 withdrawals (1-2 calls)", "storage 2 x 0.00125 (USDC), gas ~0.004"],
    ["6 everything back to the dev wallet (~6 calls)", "storage 0.00125 (dev on USDC), gas ~0.006"],
  ];
  for (const [a, b] of rows) console.log(`  ${a.padEnd(48)} ${b}`);
  console.log(`  total spent: about 0.03 NEAR (${usd(milli(30))}); the rest returns to the dev wallet (the 0.15 NEAR swapped comes back as about 0.54 USDC)`);
  console.log(`  a round needs ${fmt(PLAN.trader + PLAN.maker + PLAN.devFloor)} NEAR in the dev wallet to start; one more round after a finished one: --execute --again`);

  // dry run: a real quote and the real agents' signed trade, simulated by intents.near (nothing is sent)
  const dry = await oneClick.quote(quoteRequest({ dry: true, originAsset: mt(I.wnear.id), destinationAsset: mt(I.usdc.id), amount: PLAN.swapIn.toString(), recipient: trader.accountId, refundTo: trader.accountId, depositType: "INTENTS", refundType: "INTENTS", recipientType: "INTENTS", ...(process.env.ONECLICK_API_KEY ? { confidentiality: "basic" as const } : {}) }));
  const usdcIn = BigInt(dry.quote.minAmountOut);
  const wnearOut = priceAsk({ sellAmount: usdcIn, sellDecimals: 6, sellUsd: 1, buyDecimals: 24, buyUsd: nearUsd, spreadBps: 25 });
  console.log(`\nDry run: 1Click would give at least ${fmt(usdcIn, 6)} USDC for 0.15 wNEAR; the maker would give ${fmt(wnearOut)} wNEAR for it`);
  const trade = await signTrade(trader, maker, { token: I.usdc.id, amount: usdcIn }, { token: I.wnear.id, amount: wnearOut }, Date.now() + 10 * 60_000);
  try {
    const sim = await verifierView.simulate(MAINNET, I.verifier, [trade.a, trade.b]);
    console.log(`intents.near simulates the trade: ${sim.invariant_violated ? `unbalanced ${JSON.stringify(sim.invariant_violated)}` : `${sim.intents_executed.length} intents would execute`}`);
  } catch (e) {
    // before funding the agents hold nothing: the verifier then stops at the balance, after checking signatures and nonces
    console.log(`intents.near simulates the trade: ${(e as Error).message}${/insufficient balance/.test((e as Error).message) ? " (expected before funding: signatures, keys and nonces passed)" : ""}`);
  }
  if (!EXECUTE) {
    console.log("\nNothing was sent. Run with --execute after the owner's yes and a funded dev wallet.");
    return;
  }

  if (AGAIN) {
    if (!done("return")) throw new Error("--again starts a new round after a finished one; this round has not finished (run --execute to resume it)");
    // the finished round stays on the record; a new one starts on what came back
    state.earlier = [...(state.earlier ?? []), Object.values(state.steps)];
    state.steps = {};
    write();
  }
  // 1. fund the agents
  if (!done("fund")) {
    const have = (await dev.nearBalance()) ?? 0n;
    if (have < PLAN.trader + PLAN.maker + PLAN.devFloor) throw new Error(`the dev wallet holds ${fmt(have)} NEAR; it needs ${fmt(PLAN.trader + PLAN.maker + PLAN.devFloor)}`);
    save("fund", [await dev.transfer(trader.accountId, PLAN.trader), await dev.transfer(maker.accountId, PLAN.maker)], "dev wallet funds the trader and the maker");
  }
  // 2. wrap and deposit
  for (const [agent, amount] of [[trader, PLAN.traderWrap], [maker, PLAN.makerWrap]] as const) {
    const s = `deposit-${agent.label}`;
    if (done(s)) continue;
    const txs = [await agent.ensureRegistered(I.wnear.id), await agent.send(verifierCalls.wrap(I.wnear.id, amount)), await agent.deposit(I.wnear.id, amount)].filter((x): x is string => !!x);
    save(s, txs, `${agent.label} wraps ${fmt(amount)} NEAR and deposits it into intents.near`);
  }
  // 3. 1Click swap from the trader's Intents balance
  if (!done("swap")) {
    const q = await oneClick.quote(quoteRequest({ dry: false, originAsset: mt(I.wnear.id), destinationAsset: mt(I.usdc.id), amount: PLAN.swapIn.toString(), recipient: trader.accountId, refundTo: trader.accountId, depositType: "INTENTS", refundType: "INTENTS", recipientType: "INTENTS", ...(process.env.ONECLICK_API_KEY ? { confidentiality: "basic" as const } : {}) }));
    const to = q.quote.depositAddress!;
    const signed = await trader.sign([{ intent: "transfer", receiver_id: to, tokens: { [mt(I.wnear.id)]: PLAN.swapIn.toString() } }], Date.now() + 10 * 60_000);
    const { txHash } = await executeSigned(trader, [signed]);
    await oneClick.submitDeposit(txHash, to).catch(() => undefined);
    let status = "";
    for (let i = 0; i < 120 && !["SUCCESS", "REFUNDED", "FAILED"].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      status = (await oneClick.status(to).catch(() => ({ status: "" }))).status;
    }
    if (status !== "SUCCESS") throw new Error(`the 1Click swap ended ${status || "without an answer"} (deposit address ${to})`);
    save("swap", [txHash], `trader swaps 0.15 wNEAR for USDC through 1Click (${q.quote.amountOutFormatted} USDC quoted, deposit address ${to})`);
  }
  // 4. the direct trade
  if (!done("trade")) {
    const usdcHeld = (await trader.balances([I.usdc.id]))[I.usdc.id]!;
    const price = (await mids()).NEAR!;
    const give = priceAsk({ sellAmount: usdcHeld, sellDecimals: 6, sellUsd: 1, buyDecimals: 24, buyUsd: price, spreadBps: 25 });
    const t = await signTrade(trader, maker, { token: I.usdc.id, amount: usdcHeld }, { token: I.wnear.id, amount: give }, Date.now() + 10 * 60_000);
    const r = await executeSigned(maker, [t.a, t.b]);
    save("trade", [r.txHash], `trader gives ${fmt(usdcHeld, 6)} USDC for ${fmt(give)} wNEAR from the maker at NEAR ${price}; one execute_intents, both legs or neither`);
  }
  // 5. withdraw everything from the verifier
  if (!done("withdraw")) {
    const txs: string[] = [];
    const signed = [];
    for (const agent of [trader, maker]) {
      const held = await agent.balances([I.usdc.id, I.wnear.id]);
      for (const [token, amount] of Object.entries(held)) if (amount > 0n) {
        const reg = await agent.ensureRegistered(token);
        if (reg) txs.push(reg);
      }
      const legs = Object.entries(held).map(([token, amount]) => ({ token, amount }));
      if (legs.some((l) => l.amount > 0n)) signed.push(await agent.withdrawals(legs, agent.accountId, Date.now() + 10 * 60_000));
    }
    if (signed.length) txs.push((await executeSigned(trader, signed)).txHash);
    save("withdraw", txs, "both agents withdraw their USDC and wNEAR from intents.near");
  }
  // 6. everything back to the dev wallet
  if (!done("return")) {
    const txs: string[] = [];
    const devReg = await dev.ensureRegistered(I.usdc.id);
    if (devReg) txs.push(devReg);
    for (const agent of [trader, maker]) {
      const w = await agent.tokenBalance(I.wnear.id);
      if (w > 0n) txs.push(await agent.send({ receiver: I.wnear.id, method: "near_withdraw", args: { amount: w.toString() }, gas: 30n * 10n ** 12n, deposit: 1n }));
      const u = await agent.tokenBalance(I.usdc.id);
      if (u > 0n) txs.push(await agent.send({ receiver: I.usdc.id, method: "ft_transfer", args: { receiver_id: dev.accountId, amount: u.toString() }, gas: 30n * 10n ** 12n, deposit: 1n }));
      const n = (await agent.nearBalance()) ?? 0n;
      if (n > milli(5)) txs.push(await agent.transfer(dev.accountId, n - milli(5)));
    }
    save("return", txs, "both agents send their NEAR and USDC back to the dev wallet");
  }
  console.log(`\nDone. Dev wallet: ${fmt((await dev.nearBalance()) ?? 0n)} NEAR and ${fmt(await dev.tokenBalance(I.usdc.id), 6)} USDC. Record: deployments/mainnet-intents.json`);
}

main().catch((e) => {
  console.error("intents-mainnet:", (e as Error).message);
  process.exit(1);
});
