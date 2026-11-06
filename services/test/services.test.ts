/** Service logic that needs no network: parsing, pricing, signatures and the deal rooms. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { encode } from "@msgpack/msgpack";
import { nep413Hash, TESTNET } from "@hushd/sdk";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { decodeSignedDelegateAction, encodeSignedDelegateAction } from "near-kit";
import { AGENT_API_USDC, AGENT_API_WNEAR, hushdAgentPolicy, ownerKey, signOwnerIntent } from "../src/agent-api.js";
import { buildApi } from "../src/api.js";
import { Db } from "../src/db.js";
import { addressOfKey, approveAgentDigest, evmAddress, signDigest } from "../src/hyperliquid.js";
import { eventsInBlock, eventsInTx } from "../src/indexer.js";
import { orderAction, toRsv } from "../src/keeper.js";
import { bondFor, hedgeMargin, priceAsk, spreadBps } from "../src/makers.js";
import { checkDelegate } from "../src/relayer.js";
import { capByMarket, wirePrice, wireSize } from "../src/market.js";
import { parseTargets } from "../src/topup.js";
import { parseAsk, report } from "../src/market-agent.js";

describe("indexer", () => {
  const block = (status: Record<string, unknown>, receiver: string, logs: string[]) => ({
    block: { header: { height: 7, timestamp_nanosec: "1800000000000000000" } },
    shards: [{ receipt_execution_outcomes: [{ tx_hash: "tx1", receipt: { receipt_id: "r1", receiver_id: receiver }, execution_outcome: { outcome: { logs, status } } }] }],
  });
  const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: "hushd", version: "1.0.0", event, data: [{ deal_id: "3" }] })}`;

  test("keeps our events from successful receipts of watched contracts", () => {
    const out = eventsInBlock(block({ SuccessValue: "" }, "desk.hushd.testnet", [ev("deal_matched"), "plain log"]), new Set(["desk.hushd.testnet"]));
    assert.equal(out.length, 1);
    assert.deepEqual([out[0]!.event, out[0]!.contract, out[0]!.blockMs, out[0]!.logIndex, out[0]!.txHash], ["deal_matched", "desk.hushd.testnet", 1_800_000_000_000, 0, "tx1"]);
  });
  test("reads the same events from the transactions API", () => {
    const rcpt = (executor: string, status: Record<string, unknown>, logs: string[]) => ({ execution_outcome: { id: `r-${executor}`, block_height: 9, block_timestamp: 1_800_000_000_123_456_789, outcome: { logs, executor_id: executor, status } } });
    const tx = { transaction: { hash: "tx2" }, receipts: [rcpt("desk.hushd.testnet", { SuccessReceiptId: "x" }, ["plain", ev("bond_slashed")]), rcpt("desk.hushd.testnet", { Failure: {} }, [ev("x")]), rcpt("other.testnet", { SuccessValue: "" }, [ev("y")])] };
    const out = eventsInTx(tx, new Set(["desk.hushd.testnet"]));
    assert.deepEqual(out.map((e) => [e.event, e.logIndex, e.blockHeight, e.blockMs, e.txHash, e.receiptId]), [["bond_slashed", 1, 9, 1_800_000_000_123, "tx2", "r-desk.hushd.testnet"]]);
  });
  test("ignores failed receipts and other contracts", () => {
    assert.equal(eventsInBlock(block({ Failure: {} }, "desk.hushd.testnet", [ev("x")]), new Set(["desk.hushd.testnet"])).length, 0);
    assert.equal(eventsInBlock(block({ SuccessValue: "" }, "other.testnet", [ev("x")]), new Set(["desk.hushd.testnet"])).length, 0);
  });
});

describe("keeper", () => {
  test("MPC signatures become Hyperliquid r, s, v", () => {
    const rsv = toRsv({ big_r: { affine_point: `02${"ab".repeat(32)}` }, s: { scalar: "cd".repeat(32) }, recovery_id: 1 });
    assert.deepEqual(rsv, { r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}`, v: 28 });
  });
  test("the order sent is the order the desk hashed", () => {
    // contracts/desk/src/hedge.rs pins this msgpack for asset 4, buy, 1100, 0.2, IOC.
    const action = orderAction({ asset: 4, coin: "X", is_buy: true, size: "0.2", limit_px: "1100", deadline_ms: 0, testnet: true }, false);
    assert.equal(Buffer.from(encode(action)).toString("hex"), "83a474797065a56f72646572a66f72646572739186a16104a162c3a170a431313030a173a3302e32a172c2a17481a56c696d697481a3746966a3496f63a867726f7570696e67a26e61");
  });
});

describe("relayer meta transactions", () => {
  const allow = { "desk.hushd.testnet": ["set_maker_active", "withdraw_bond"] };
  // a real NEP-366 payload, encoded and decoded the way a maker's wallet and the relayer do
  const delegate = (receiverId: string, methodName: string, deposit: bigint) =>
    decodeSignedDelegateAction(
      encodeSignedDelegateAction({
        signedDelegate: {
          delegateAction: {
            senderId: "maker-a.hushd.testnet",
            receiverId,
            actions: [{ functionCall: { methodName, args: new TextEncoder().encode("{}"), gas: 30_000_000_000_000n, deposit } }],
            nonce: 1n,
            maxBlockHeight: 100n,
            publicKey: { ed25519Key: { data: Array(32).fill(1) } },
          },
          signature: { ed25519Signature: { data: Array(64).fill(2) } },
        },
      } as never),
    );
  test("relays allowlisted calls with the 1 yoctoNEAR the desk asks for", () => {
    checkDelegate(allow, delegate("desk.hushd.testnet", "withdraw_bond", 1n) as never);
  });
  test("refuses a missing yocto, other methods and other contracts", () => {
    assert.throws(() => checkDelegate(allow, delegate("desk.hushd.testnet", "withdraw_bond", 0n) as never), /exactly 1 yoctoNEAR/);
    assert.throws(() => checkDelegate(allow, delegate("desk.hushd.testnet", "propose_config", 1n) as never), /allowlisted/);
    assert.throws(() => checkDelegate(allow, delegate("pool.hushd.testnet", "withdraw_bond", 1n) as never), /does not send/);
    assert.throws(() => checkDelegate(allow, {}), /signed delegate/);
  });
});

describe("hyperliquid agent approval", () => {
  // vectors from eth_account (encode_typed_data, sign_message) and eth_keys
  test("approveAgent digest and signature match eth_account", () => {
    const d = approveAgentDigest({ agentAddress: `0x${"ab".repeat(20)}`, agentName: "", nonce: 1_700_000_000_000, testnet: true });
    assert.equal(Buffer.from(d).toString("hex"), "b5ee06e24dac21716eb817fcb1b159c8e340fbcfc0eb5a555cc14f831163148c");
    assert.deepEqual(signDigest(`0x${"11".repeat(32)}`, d), {
      r: "0x263733c068009f98897ba61c68465c659264ae6d65e0e916224238122de36e3e",
      s: "0x2343d6f31fc14f2c67e4036041cd7cd464ba9850a6645ff149837f565a35ab5e",
      v: 27,
    });
  });
  test("an MPC public key becomes the deal's Hyperliquid address", () => {
    const pub = Buffer.from("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276728176c3c6431f8eeda4538dc37c865e2784f3a9e77d044f33e407797e1278a", "hex");
    assert.equal(evmAddress(pub), "0x1563915e194d8cfba1943570603f7606a3115508");
  });
  test("a maker's key gives its Hyperliquid address", () => {
    // the well-known address of private key 1
    assert.equal(addressOfKey(`0x${"00".repeat(31)}01`), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });
});

describe("makers", () => {
  test("spreads by style", () => {
    assert.equal(spreadBps("fixed", { volBps: 999, inventoryRatio: 0 }), 25);
    assert.equal(spreadBps("volatility", { volBps: 100, inventoryRatio: 1 }), 70);
    assert.equal(spreadBps("volatility", { volBps: 0, inventoryRatio: 1 }), 15);
    assert.equal(spreadBps("inventory", { volBps: 0, inventoryRatio: 1 }), 15);
    assert.equal(spreadBps("inventory", { volBps: 0, inventoryRatio: 0 }), 75);
  });
  test("bonds come in steps of whole USDC and respect the desk's minimum", () => {
    const usdc = (n: number) => BigInt(n) * 1_000_000n;
    assert.equal(bondFor(500, 6, usdc(1_000)), usdc(1_000));
    assert.equal(bondFor(12_000, 6, usdc(1_000)), usdc(2_000));
    assert.equal(bondFor(30_000, 6, usdc(1_000)), usdc(5_000));
    assert.equal(bondFor(2_500_000, 6, usdc(1_000)), usdc(300_000));
    assert.equal(bondFor(500, 6, usdc(3_000)), usdc(3_000));
  });
  test("a hedge needs margin at half the coin's maximum leverage", () => {
    assert.equal(hedgeMargin(10_000, 40), 500);
    assert.equal(hedgeMargin(10_000, 20), 1_000);
    assert.equal(hedgeMargin(10_000, 1), 10_000);
  });
  test("pricing rounds in the maker's favour", () => {
    // 1,000 USDC for BTC at 60,000 with 25 bps: 0.01662499... BTC, floored to 8 decimals
    const give = priceAsk({ sellAmount: 1_000_000_000n, sellDecimals: 6, sellUsd: 1, buyDecimals: 8, buyUsd: 60_000, spreadBps: 25 });
    assert.equal(give, 1_662_500n);
  });
  test("a quote never beats the NEAR Intents price less the spread", () => {
    assert.equal(capByMarket(1_700_000n, 1_662_500n, 25), 1_658_343n);
    assert.equal(capByMarket(1_600_000n, 1_662_500n, 25), 1_600_000n);
    assert.equal(capByMarket(1_600_000n, null, 25), 1_600_000n);
  });
  test("Hyperliquid wire numbers", () => {
    assert.equal(wireSize(0.016625, 5), "0.01662");
    assert.equal(wirePrice(59_400.123, 5), "59400");
    assert.equal(wirePrice(2.123456, 1), "2.1235");
  });
});

test("top-up targets", () => {
  assert.deepEqual(parseTargets("a.testnet:5, b.testnet:0.5"), [
    { account: "a.testnet", floor: 5n * 10n ** 24n },
    { account: "b.testnet", floor: 5n * 10n ** 23n },
  ]);
  assert.throws(() => parseTargets("a.testnet"));
});

describe("deal rooms (Postgres)", () => {
  const db = new Db(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/hushd_test");
  const api = buildApi(TESTNET, db, () => 1_000);
  const to = `0x${"11".repeat(32)}`;
  let pg = true;
  before(async () => {
    try {
      await db.migrate();
      await db.q("delete from messages");
    } catch {
      pg = false;
    }
  });
  after(() => db.close());

  test("only the named recipient's messages come back, in order", async (t) => {
    if (!pg) return t.skip("no Postgres at TEST_DATABASE_URL");
    for (const [r, box] of [[to, "QUJD"], [`0x${"22".repeat(32)}`, "REVG"], [to, "R0hJ"]] as const) {
      const res = await api.request(`/v1/deals/4/messages`, { method: "POST", body: JSON.stringify({ to: r, box }), headers: { "content-type": "application/json" } });
      assert.equal(res.status, 200);
    }
    const list = (await (await api.request(`/v1/deals/4/messages?to=${to}`)).json()) as { id: number; box: string }[];
    assert.deepEqual(list.map((m) => m.box), ["QUJD", "R0hJ"]);
    const after1 = (await (await api.request(`/v1/deals/4/messages?to=${to}&after=${list[0]!.id}`)).json()) as unknown[];
    assert.equal(after1.length, 1);
  });

  test("malformed messages are refused", async (t) => {
    if (!pg) return t.skip("no Postgres at TEST_DATABASE_URL");
    const bad = await api.request(`/v1/deals/4/messages`, { method: "POST", body: JSON.stringify({ to: "nope", box: "QUJD" }), headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 400);
  });
});

test("a service records the events of its own transaction", async () => {
  const { eventsInOutcome } = await import("../src/indexer.js");
  const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: "hushd", version: "1.0.0", event, data: [{ deal_id: "0" }] })}`;
  const outcome = {
    transaction: { hash: "tx9" },
    receipts_outcome: [
      { id: "r1", block_hash: "b", outcome: { executor_id: "desk.hushd.testnet", logs: [ev("deal_matched")], status: { SuccessValue: "" } } },
      { id: "r2", block_hash: "b", outcome: { executor_id: "other.testnet", logs: [ev("deal_matched")], status: { SuccessValue: "" } } },
      { id: "r3", block_hash: "b", outcome: { executor_id: "desk.hushd.testnet", logs: [ev("receipt")], status: { Failure: {} } } },
    ],
  };
  const out = eventsInOutcome(outcome, new Set(["desk.hushd.testnet"]), { height: 5, ms: 7 });
  assert.deepEqual(out.map((e) => [e.event, e.receiptId, e.txHash, e.blockHeight]), [["deal_matched", "r1", "tx9", 5]]);
});

describe("NEAR Intents routes (1Click stubbed, no network)", () => {
  const ZERO = "0".repeat(64);
  const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const APTOS_USDC = "nep141:aptos-usdc.omft.near";
  const STELLAR_USDC = "nep245:v2_1.omni.hot.tg:1100_usdc";
  const ADDRESS = `0x${"11".repeat(20)}`;
  const LIST = [
    { assetId: USDC, decimals: 6, blockchain: "near", symbol: "USDC", price: 0.9995 },
    { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 3.74 },
    { assetId: "nep141:nbtc.bridge.near", decimals: 8, blockchain: "near", symbol: "BTC", price: 76_048 },
    { assetId: "nep141:eth.bridge.near", decimals: 18, blockchain: "near", symbol: "ETH", price: 2_240 },
    { assetId: "nep141:aptos.omft.near", decimals: 8, blockchain: "aptos", symbol: "APT", price: 0.61 },
    { assetId: APTOS_USDC, decimals: 6, blockchain: "aptos", symbol: "USDC", price: 0.9995 },
    { assetId: "nep141:avax-aave.omft.near", decimals: 18, blockchain: "avax", symbol: "AAVE", price: 129 },
    { assetId: "nep141:avax-usdt.omft.near", decimals: 6, blockchain: "avax", symbol: "USDT", price: 0.999 },
    { assetId: STELLAR_USDC, decimals: 7, blockchain: "stellar", symbol: "USDC", price: 0.9995 },
    { assetId: "nep245:v2_1.omni.hot.tg:9745_xpl", decimals: 18, blockchain: "plasma", symbol: "XPL_(DEPRECATED)", price: 0.058 },
    { assetId: "nep141:qtc.omft.near", decimals: 8, blockchain: "qtc", symbol: "QTC", price: 70 },
    { assetId: "nep141:zeta.omft.near", decimals: 18, blockchain: "zetachain", symbol: "ZETA", price: 0.2 },
  ];
  type Call = { path: string; body: Record<string, unknown> | undefined; headers: Record<string, string> };
  type Answer = { status?: number; body: unknown };
  const echo = (body: Record<string, unknown>): Answer => ({
    status: 201,
    body: {
      quote: { amountIn: body.amount, amountInFormatted: "25.0", amountInUsd: "24.98", amountOut: "24997517", amountOutFormatted: "24.997517", amountOutUsd: "24.98", minAmountOut: "24747541", timeEstimate: 35, withdrawFee: "0" },
      quoteRequest: { ...body, confidentiality: body.confidentiality ?? "public", appFees: [{ recipient: "fees.near", fee: 1 }] },
      signature: "ed25519:stub",
      timestamp: "2026-11-06T12:00:00.000Z",
    },
  });
  const dbs: Db[] = [];
  after(() => Promise.all(dbs.map((d) => d.close())));
  const keyBefore = process.env.ONECLICK_API_KEY;
  after(() => {
    if (keyBefore === undefined) delete process.env.ONECLICK_API_KEY;
    else process.env.ONECLICK_API_KEY = keyBefore;
  });

  function setup(o: { quote?: (body: Record<string, unknown>, headers: Record<string, string>) => Answer; recordPath?: string; clock?: { t: number } } = {}) {
    const calls: Call[] = [];
    const stub: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ path, body, headers });
      const r: Answer = path === "/v0/tokens" ? { status: 200, body: LIST } : (o.quote ?? echo)(body!, headers);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    };
    const db = new Db("postgres://localhost:1/unused");
    dbs.push(db);
    const clock = o.clock ?? { t: 1_000 };
    const api = buildApi(TESTNET, db, () => clock.t, { fetch: stub, recordPath: o.recordPath ?? "/nonexistent/mainnet-intents.json" });
    const quote = (b: Record<string, unknown>) => api.request("/v1/intents/quote", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
    return { api, calls, quote, quotes: () => calls.filter((c) => c.path === "/v0/quote") };
  }
  const deposit = { direction: "deposit", asset: APTOS_USDC, token: "USDC", amount: "25000000", address: ADDRESS };

  test("the token list comes by chain, named and sorted, without NEAR or deprecated assets, and is cached ten minutes", async () => {
    const clock = { t: 1_000 };
    const { api, calls } = setup({ clock });
    const body = (await (await api.request("/v1/intents/tokens")).json()) as { chains: { id: string; name: string; tokens: { symbol: string }[] }[]; hushd: { symbol: string; assetId: string; decimals: number }[] };
    assert.deepEqual(
      body.chains.map((c) => [c.id, c.name, c.tokens.map((t) => t.symbol)]),
      [["aptos", "Aptos", ["USDC", "APT"]], ["avax", "Avalanche", ["USDT", "AAVE"]], ["qtc", "QTC", ["QTC"]], ["stellar", "Stellar", ["USDC"]], ["zetachain", "Zetachain", ["ZETA"]]],
    );
    assert.deepEqual(body.hushd.map((t) => [t.symbol, t.assetId, t.decimals]), [["USDC", USDC, 6], ["wNEAR", "nep141:wrap.near", 24], ["BTC", "nep141:nbtc.bridge.near", 8]]);
    clock.t += 9 * 60_000;
    await api.request("/v1/intents/tokens");
    assert.equal(calls.length, 1);
    clock.t += 2 * 60_000;
    await api.request("/v1/intents/tokens");
    assert.equal(calls.length, 2);
  });

  test("a deposit quote is always dry, public without a partner key, and pays the all-zero NEAR account", async () => {
    delete process.env.ONECLICK_API_KEY;
    const { quote, quotes } = setup();
    const r = await quote({ ...deposit, dry: false });
    assert.equal(r.status, 200);
    const sent = quotes()[0]!;
    assert.equal(sent.body!.dry, true);
    assert.deepEqual(
      [sent.body!.originAsset, sent.body!.destinationAsset, sent.body!.amount, sent.body!.refundTo, sent.body!.recipient, sent.body!.depositType, sent.body!.recipientType, sent.body!.confidentiality],
      [APTOS_USDC, USDC, "25000000", ADDRESS, ZERO, "ORIGIN_CHAIN", "DESTINATION_CHAIN", undefined],
    );
    assert.equal(sent.headers["x-api-key"], undefined);
    const body = (await r.json()) as { confidential: boolean; nearAccount: string; from: { chainName: string; symbol: string }; to: { chainName: string }; quote: { amountOut: string } };
    assert.deepEqual([body.confidential, body.nearAccount, body.from.chainName, body.from.symbol, body.to.chainName, body.quote.amountOut], [false, ZERO, "Aptos", "USDC", "NEAR", "24997517"]);
  });

  test("with a partner key a cash out asks for confidentiality and says it got it", async () => {
    process.env.ONECLICK_API_KEY = "partner-key";
    try {
      const { quote, quotes } = setup();
      const r = await quote({ direction: "cashout", asset: APTOS_USDC, token: "USDC", amount: "1000000", address: ADDRESS });
      assert.equal(r.status, 200);
      const sent = quotes()[0]!;
      assert.deepEqual([sent.body!.originAsset, sent.body!.destinationAsset, sent.body!.refundTo, sent.body!.recipient, sent.body!.confidentiality, sent.headers["x-api-key"]], [USDC, APTOS_USDC, ZERO, ADDRESS, "basic", "partner-key"]);
      assert.equal(((await r.json()) as { confidential: boolean }).confidential, true);
    } finally {
      delete process.env.ONECLICK_API_KEY;
    }
  });

  test("a refused partner key falls back to a public quote that says it is public", async () => {
    process.env.ONECLICK_API_KEY = "stale-key";
    try {
      const { quote, quotes } = setup({ quote: (b, h) => (h["x-api-key"] ? { status: 401, body: { message: "Unauthorized" } } : echo(b)) });
      const r = await quote(deposit);
      assert.equal(r.status, 200);
      assert.equal(((await r.json()) as { confidential: boolean }).confidential, false);
      assert.deepEqual(quotes().map((c) => c.body!.confidentiality), ["basic", undefined]);
    } finally {
      delete process.env.ONECLICK_API_KEY;
    }
  });

  test("Stellar deposits ask for a memo deposit", async () => {
    const { quote, quotes } = setup();
    assert.equal((await quote({ ...deposit, asset: STELLAR_USDC, amount: "250000000", address: "GABC" })).status, 200);
    assert.equal(quotes()[0]!.body!.depositMode, "MEMO");
  });

  test("bad input is refused before 1Click is asked", async () => {
    const { quote, quotes } = setup();
    for (const bad of [
      { ...deposit, direction: "swap" },
      { ...deposit, amount: "1.5" },
      { ...deposit, amount: "0" },
      { ...deposit, address: " " },
      { ...deposit, asset: USDC },
      { ...deposit, token: "DOGE" },
    ]) {
      const r = await quote(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal(quotes().length, 0);
  });

  test("1Click's refusals come back in plain words", async () => {
    const say = (message: string) => setup({ quote: () => ({ status: 400, body: { message } }) }).quote;
    const words = async (message: string, b = deposit) => {
      const r = await say(message)(b);
      assert.equal(r.status, 400);
      return ((await r.json()) as { error: string }).error;
    };
    assert.match(await words("refundTo is not valid"), /^That is not a valid Aptos address\./);
    assert.match(await words("recipient is not valid", { ...deposit, direction: "cashout" }), /^That is not a valid Aptos address to receive USDC on\./);
    assert.equal(await words("Amount is too low for bridge, try at least 300001"), "That is too little for this route. Send at least 0.300001 USDC.");
    assert.equal(await words("Temporary swap limits: minimum swap amount is $1,000"), "Temporary swap limits: minimum swap amount is $1,000.");
  });

  test("the mainnet trades are the record's steps, or none before it exists", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    assert.deepEqual(await (await setup().api.request("/v1/intents/trades")).json(), { steps: [] });
    const record = { network: "mainnet", verifier: "intents.near", explorer: "https://nearblocks.io/txns/", steps: [{ step: "fund", txs: ["abc"], note: "dev wallet funds the trader and the maker", at: "2026-11-07T10:00:00.000Z" }] };
    const path = join(mkdtempSync(join(tmpdir(), "hushd-intents-")), "mainnet-intents.json");
    writeFileSync(path, JSON.stringify(record));
    assert.deepEqual(await (await setup({ recordPath: path }).api.request("/v1/intents/trades")).json(), record);
  });
});

describe("agent market worker", () => {
  test("reads a pair and a size the ways people write them", () => {
    assert.deepEqual(parseAsk("Sell 2,500 USDC for NEAR please"), { sellAmount: 2500, sell: "USDC", buy: "NEAR" });
    assert.deepEqual(parseAsk("swap 0.5 btc to usdc"), { sellAmount: 0.5, sell: "BTC", buy: "USDC" });
    assert.deepEqual(parseAsk("2500 usdc -> wnear"), { sellAmount: 2500, sell: "USDC", buy: "WNEAR" });
    assert.deepEqual(parseAsk("buy NEAR with 1,000 USDC"), { sellAmount: 1000, sell: "USDC", buy: "NEAR" });
    assert.equal(parseAsk("what is the weather"), null);
  });
  test("the report compares every quote with the mid and says what it could not do", () => {
    const md = report({
      ask: { sellAmount: 1000, sell: "USDC", buy: "NEAR" },
      mid: { sellUsd: 1, buyUsd: 4, fairOut: 250 },
      oneClick: { out: 249.5, outUsd: 998, route: "near USDC to near wNEAR" },
      makers: [{ name: "Steady", out: 249, paidTx: "tx1" }],
      notes: ["Weather had no quote for this size right now."],
    });
    assert.match(md, /\| Hyperliquid mid \(fair value\) \| 250 NEAR \| 0 bps \|/);
    assert.match(md, /\| NEAR Intents, 1Click \(near USDC to near wNEAR\) \| 249\.5 NEAR \| -20\.0 bps \|/);
    assert.match(md, /\| Hushd maker Steady \(testnet, indicative\) \| 249 NEAR \| -40\.0 bps \|/);
    assert.match(md, /private x402.*\[Steady\]\(https:\/\/testnet\.nearblocks\.io\/txns\/tx1\)/);
    assert.match(md, /- Weather had no quote/);
  });
});

describe("NEAR Intents Agent API owner", () => {
  const owner = ownerKey(new Uint8Array(32).fill(7));
  const policy = hushdAgentPolicy({ transferTo: ["maker.near"], withdrawTo: [owner.accountId], dailyUsd: "5", perTransaction: { [AGENT_API_WNEAR]: "200000000000000000000000" } });

  test("the demo policy allows only wNEAR and USDC, and pays only the listed accounts", () => {
    assert.deepEqual(policy.assets, [AGENT_API_WNEAR, AGENT_API_USDC]);
    assert.equal(policy.destinations.mode, "only");
    assert.deepEqual(policy.destinations.list, [
      { action: "transfer", address: "maker.near", confidential: false },
      { action: "withdraw", chain: "near", address: owner.accountId, memo: null },
    ]);
    assert.equal(policy.budget.daily_usd, "5");
    assert.equal(policy.frozen, false);
  });

  test("a NEP-413 owner signature verifies against the owner's key", async () => {
    const nonce = new Uint8Array(32).fill(3);
    const intent = { standard: "nep413" as const, payload: { message: '{"policy":"x"}', recipient: "outlayer.near", nonce: base64.encode(nonce) } };
    const signed = await signOwnerIntent(intent, owner, TESTNET);
    assert.equal(signed.standard, "nep413");
    if (signed.standard !== "nep413") return;
    assert.equal(signed.public_key, owner.publicKey);
    assert.ok(ed25519.verify(base64.decode(signed.signature), nep413Hash(intent.payload.message, nonce, intent.payload.recipient), ed25519.getPublicKey(owner.secret)));
  });

  test("a NEP-366 owner delegate action carries the calls as given and a valid signature", async () => {
    const intent = {
      standard: "nep366" as const,
      payload: { receiverId: "outlayer.near", actions: [{ type: "FunctionCall" as const, params: { methodName: "store_wallet_policy", args: { wallet_id: "w1" }, gas: "30000000000000", deposit: "10000000000000000000000" } }] },
    };
    const signed = await signOwnerIntent(intent, owner, TESTNET, { nonce: 5n, maxBlockHeight: 1000n });
    assert.equal(signed.standard, "nep366");
    if (signed.standard !== "nep366") return;
    const bytes = base64.decode(signed.signed_delegate);
    const decoded = decodeSignedDelegateAction(bytes) as unknown as { signedDelegate: { delegateAction: { senderId: string; receiverId: string; nonce: bigint; maxBlockHeight: bigint } } };
    const action = decoded.signedDelegate.delegateAction;
    assert.equal(action.senderId, owner.accountId);
    assert.equal(action.receiverId, "outlayer.near");
    assert.equal(BigInt(action.nonce), 5n);
    // the signature (key type byte, 64 bytes) closes the payload; it signs sha256(2^30 + 366 as u32 LE ‖ the delegate action)
    const actionBytes = bytes.slice(0, bytes.length - 65);
    const prefix = new Uint8Array(new Uint32Array([2 ** 30 + 366]).buffer);
    assert.equal(bytes[bytes.length - 65], 0);
    assert.ok(ed25519.verify(bytes.slice(bytes.length - 64), sha256(new Uint8Array([...prefix, ...actionBytes])), ed25519.getPublicKey(owner.secret)));
  });
});
