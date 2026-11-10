/** Makers' records from the desk's deals, and the rule that stops asking makers that let deals lapse. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { x25519 } from "@noble/curves/ed25519.js";
import type { DealView, DeskApi, MakerView } from "../src/desk.ts";
import { openRfq } from "../src/desk.ts";
import { TESTNET } from "../src/network.ts";
import type { RelayerClient } from "../src/relayer.ts";
import { dealEnd, LAPSE_MAX_RATE, LAPSE_MIN_DEALS, lapsesTooOften, makerRecords, makersToAsk, readMakerRecords, RECORD_MAX_AGE_MS, RECORD_WINDOW } from "../src/reputation.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

type End = "settled" | "failed" | "recovered" | "open" | "hedge_pending" | "slash_refused" | "overdue";

/** A deal as `desk.deals` returns it, ended as `end`, matched `ageMs` ago. */
function deal(id: number, maker: string, end: End, ageMs = HOUR): DealView {
  const matched = NOW - ageMs;
  const closed = end === "settled" || end === "failed" || end === "recovered";
  const status: DealView["status"] = closed ? "closed" : end === "hedge_pending" ? "hedge_pending" : end === "slash_refused" ? "slash_refused" : "matched";
  return {
    id: String(id),
    rfq_id: String(id),
    maker,
    terms_hash: "0x00",
    class: "atomic_pool",
    matched_at_ms: String(matched),
    // an open deal still has time; an overdue one ran out and nobody marked it yet
    expires_at_ms: String(end === "overdue" ? NOW - 1 : end === "open" ? NOW + 60_000 : matched + 240_000),
    bond: "0",
    hedge: null,
    status,
    settle_attempts: end === "settled" ? 1 : 0,
    hedge_orders: 0,
    hedge_attempts: 0,
    bond_released: closed,
    slash_held: "0",
    attested_by: "enclave_signature",
    receipt: closed ? { outcome: end, evidence: [], recorded_at_ms: String(matched + 10_000) } : end === "open" || end === "overdue" ? null : { outcome: "unresolved", evidence: [], recorded_at_ms: String(matched) },
  };
}

/** `ends` for one maker, newest first, ids counting down from `top`. */
const history = (maker: string, ends: End[], top = 1000) => ends.map((e, i) => deal(top - i, maker, e, HOUR + i * 60_000));

function maker(over: Partial<MakerView> = {}): MakerView {
  return { name: "M", enc_key: `0x${"11".repeat(32)}`, quote_url: "", style: "fixed", bond: "20000000000", locked: "0", deals: 0, slashed: "0", active: true, quote_key: "ed25519:x", ...over };
}

test("each deal's end reads from its status and receipt", () => {
  assert.equal(dealEnd(deal(1, "a", "settled"), NOW), "settled");
  assert.equal(dealEnd(deal(1, "a", "failed"), NOW), "lapsed");
  assert.equal(dealEnd(deal(1, "a", "recovered"), NOW), "missed_hedge");
  assert.equal(dealEnd(deal(1, "a", "slash_refused"), NOW), "missed_hedge");
  assert.equal(dealEnd(deal(1, "a", "hedge_pending"), NOW), "open");
  assert.equal(dealEnd(deal(1, "a", "open"), NOW), "open");
  // past its expiry the desk refuses a settlement, so it has lapsed before anyone calls expire
  assert.equal(dealEnd(deal(1, "a", "overdue"), NOW), "lapsed");
});

test("a record counts settled and lapsed deals, newest first, and leaves open ones out", () => {
  const deals = [...history("a", ["settled", "failed", "open", "settled", "recovered", "hedge_pending"]), ...history("b", ["settled"], 500)];
  const r = makerRecords(deals, { nowMs: NOW });
  const a = r.get("a")!;
  assert.deepEqual({ ended: a.ended, settled: a.settled, lapsed: a.lapsed, missedHedges: a.missedHedges, open: a.open }, { ended: 4, settled: 2, lapsed: 2, missedHedges: 1, open: 2 });
  assert.equal(a.lapseRate, 0.5);
  assert.deepEqual(a.dealIds, ["1000", "999", "997", "996"]);
  assert.equal(r.get("b")!.lapseRate, 0);
  assert.equal(r.get("c"), undefined);
});

test("only the latest deals in the window count, and none older than the age limit", () => {
  // 20 settled deals, then 10 older lapses that fall outside the window
  const ends: End[] = [...Array<End>(RECORD_WINDOW).fill("settled"), ...Array<End>(10).fill("failed")];
  const r = makerRecords(history("a", ends), { nowMs: NOW }).get("a")!;
  assert.equal(r.ended, RECORD_WINDOW);
  assert.equal(r.lapsed, 0);
  // the order deals arrive in does not matter: the newest ids count
  assert.equal(makerRecords(history("a", ends).reverse(), { nowMs: NOW }).get("a")!.lapsed, 0);
  // lapses from more than a week ago no longer count
  const old = [deal(10, "a", "settled"), ...[9, 8, 7, 6, 5].map((id) => deal(id, "a", "failed", RECORD_MAX_AGE_MS + HOUR))];
  assert.deepEqual(makerRecords(old, { nowMs: NOW }).get("a")!.ended, 1);
});

test("a maker is judged only on enough deals, and skipped only above the threshold", () => {
  const rec = (settled: number, lapsed: number) => makerRecords(history("a", [...Array<End>(lapsed).fill("failed"), ...Array<End>(settled).fill("settled")]), { nowMs: NOW }).get("a");
  // a new maker with lapses on too few deals is still asked
  assert.equal(lapsesTooOften(rec(0, LAPSE_MIN_DEALS - 1)), false);
  assert.equal(lapsesTooOften(undefined), false);
  // 25% exactly is allowed, anything above is not
  assert.equal(LAPSE_MAX_RATE, 0.25);
  assert.equal(lapsesTooOften(rec(15, 5)), false);
  assert.equal(lapsesTooOften(rec(14, 6)), true);
  assert.equal(lapsesTooOften(rec(3, 2)), true);
  assert.equal(lapsesTooOften(rec(4, 1)), false);
});

test("the makers asked: active, a usable key, a good record, the best bonded first", () => {
  const listed: [string, MakerView][] = [
    ["small", maker({ bond: "1" })],
    ["lapser", maker({ bond: "900" })],
    ["paused", maker({ active: false })],
    ["nokey", maker({ enc_key: "0x12" })],
    ["big", maker({ bond: "500" })],
    ["new", maker({ bond: "10" })],
  ];
  const deals = [...history("lapser", ["failed", "failed", "settled", "failed", "settled", "settled"], 1000), ...history("big", ["failed", "settled", "settled", "settled", "settled"], 500), ...history("new", ["failed"], 100)];
  const { ask, skipped } = makersToAsk(listed, makerRecords(deals, { nowMs: NOW }), 32);
  assert.deepEqual(ask.map(([acc]) => acc), ["big", "new", "small"]);
  assert.deepEqual(skipped, ["lapser"]);
  assert.deepEqual(makersToAsk(listed, new Map(), 2).ask.map(([acc]) => acc), ["lapser", "big"]);
});

// ---------- against a stubbed desk ----------

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

/** Answer the desk's view calls from `views`, and count each one. */
function stubDesk(views: Record<string, (args: Record<string, unknown>) => unknown>, calls: { method: string; args: Record<string, unknown> }[] = []) {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const { params } = JSON.parse(String(init?.body)) as { params: { method_name: string; args_base64: string } };
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString()) as Record<string, unknown>;
    calls.push({ method: params.method_name, args });
    const answer = views[params.method_name];
    if (!answer) return Response.json({ jsonrpc: "2.0", id: "hushd", error: { message: `no ${params.method_name}`, cause: { name: "STUB" } } });
    return Response.json({ jsonrpc: "2.0", id: "hushd", result: { result: [...Buffer.from(JSON.stringify(answer(args)))], logs: [] } });
  }) as typeof fetch;
  return calls;
}

test("records are read page by page, newest first, until the deals get too old", async () => {
  // 250 deals, one a minute, and 150 more from long ago
  const all = [...Array.from({ length: 250 }, (_, i) => deal(399 - i, "a", i % 10 === 0 ? "failed" : "settled", HOUR + i * 60_000)), ...Array.from({ length: 150 }, (_, i) => deal(149 - i, "a", "failed", RECORD_MAX_AGE_MS * 2))];
  const calls = stubDesk({
    deals: ({ from_index, limit }) => {
      const start = from_index === null ? all.length : Number(from_index);
      return all.filter((d) => Number(d.id) < start).slice(0, Number(limit));
    },
  });
  const { records, deals } = await readMakerRecords(TESTNET, { nowMs: NOW });
  // the third page reaches deals older than a week: no fourth is read
  assert.deepEqual(calls.map((c) => c.args.from_index), [null, "300", "200"]);
  assert.equal(deals.length, 300);
  const a = records.get("a")!;
  assert.equal(a.ended, RECORD_WINDOW);
  assert.equal(a.lapsed, 2);
});

test("openRfq leaves out a maker that lets too many deals lapse, and says so", async () => {
  const key = (fill: number) => `0x${Buffer.from(x25519.getPublicKey(new Uint8Array(32).fill(fill))).toString("hex")}`;
  const now = Date.now();
  const recent = (id: number, m: string, end: End) => ({ ...deal(id, m, end), matched_at_ms: String(now - HOUR - id * 1000), expires_at_ms: String(now - HOUR) });
  stubDesk({
    enclave: () => ({ sign_key: null, enc_key: key(9), project: "p" }),
    makers: () => [
      ["good", maker({ enc_key: key(1) })],
      ["lapser", maker({ enc_key: key(2), bond: "90000000000" })],
    ],
    deals: () => [recent(6, "lapser", "failed"), recent(5, "lapser", "failed"), recent(4, "good", "settled"), recent(3, "lapser", "settled"), recent(2, "lapser", "failed"), recent(1, "lapser", "settled"), recent(0, "lapser", "failed")],
  });
  let committed = 0;
  let asked: string[] = [];
  const relayer = { openRfq: async () => ({ rfqId: 7 + committed++ }) } as unknown as RelayerClient;
  const api = { postRfq: async (_id: number, _box: string, boxes: Record<string, string>) => ((asked = Object.keys(boxes)), { ok: true, closesAtMs: 0 }) } as unknown as DeskApi;
  const ask = { kind: "spot", sellToken: "a", buyToken: "b", sellAmount: "1", salt: "0x00" } as never;
  const opened = await openRfq({ net: TESTNET, api, relayer, request: {}, ask, windowMs: 30_000 });
  assert.equal(opened.rfqId, 7);
  assert.deepEqual(asked, ["good"]);
  assert.deepEqual(opened.skipped, ["lapser"]);

  // with no one left to ask, nothing is committed
  stubDesk({
    enclave: () => ({ sign_key: null, enc_key: key(9), project: "p" }),
    makers: () => [["lapser", maker({ enc_key: key(2) })]],
    deals: () => [recent(6, "lapser", "failed"), recent(5, "lapser", "failed"), recent(4, "lapser", "failed"), recent(3, "lapser", "failed"), recent(2, "lapser", "settled")],
  });
  await assert.rejects(openRfq({ net: TESTNET, api, relayer, request: {}, ask, windowMs: 30_000 }), /let more than 25% of its recent deals lapse/);
  assert.equal(committed, 1);
});
