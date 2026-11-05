/** Service logic that needs no network: parsing, pricing, signatures and the deal rooms. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { encode } from "@msgpack/msgpack";
import { TESTNET } from "@hushd/sdk";
import { buildApi } from "../src/api.js";
import { Db } from "../src/db.js";
import { eventsInBlock } from "../src/indexer.js";
import { orderAction, toRsv } from "../src/keeper.js";
import { priceAsk, spreadBps } from "../src/makers.js";
import { wirePrice, wireSize } from "../src/market.js";
import { parseTargets } from "../src/topup.js";

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

describe("makers", () => {
  test("spreads by style", () => {
    assert.equal(spreadBps("fixed", { volBps: 999, inventoryRatio: 0 }), 25);
    assert.equal(spreadBps("volatility", { volBps: 100, inventoryRatio: 1 }), 70);
    assert.equal(spreadBps("volatility", { volBps: 0, inventoryRatio: 1 }), 15);
    assert.equal(spreadBps("inventory", { volBps: 0, inventoryRatio: 1 }), 15);
    assert.equal(spreadBps("inventory", { volBps: 0, inventoryRatio: 0 }), 75);
  });
  test("pricing rounds in the maker's favour", () => {
    // 1,000 USDC for BTC at 60,000 with 25 bps: 0.01662499... BTC, floored to 8 decimals
    const give = priceAsk({ sellAmount: 1_000_000_000n, sellDecimals: 6, sellUsd: 1, buyDecimals: 8, buyUsd: 60_000, spreadBps: 25 });
    assert.equal(give, 1_662_500n);
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
  before(async () => {
    await db.migrate();
    await db.q("delete from messages");
  });
  after(() => db.close());

  test("only the named recipient's messages come back, in order", async () => {
    for (const [r, box] of [[to, "QUJD"], [`0x${"22".repeat(32)}`, "REVG"], [to, "R0hJ"]] as const) {
      const res = await api.request(`/v1/deals/4/messages`, { method: "POST", body: JSON.stringify({ to: r, box }), headers: { "content-type": "application/json" } });
      assert.equal(res.status, 200);
    }
    const list = (await (await api.request(`/v1/deals/4/messages?to=${to}`)).json()) as { id: number; box: string }[];
    assert.deepEqual(list.map((m) => m.box), ["QUJD", "R0hJ"]);
    const after1 = (await (await api.request(`/v1/deals/4/messages?to=${to}&after=${list[0]!.id}`)).json()) as unknown[];
    assert.equal(after1.length, 1);
  });

  test("malformed messages are refused", async () => {
    const bad = await api.request(`/v1/deals/4/messages`, { method: "POST", body: JSON.stringify({ to: "nope", box: "QUJD" }), headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 400);
  });
});
