/** The API's market routes, with Hyperliquid stood in for: what is asked, what is kept, what is refused. */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { MAINNET, TESTNET, type HushdNetwork, type MarketCandles, type MarketMids } from "@hushd/sdk";
import { buildApi } from "../src/api.js";
import { Db } from "../src/db.js";
import { minReceiveAt, parseCandles } from "../src/market.js";

const MIN = 60_000;

describe("market routes (Hyperliquid stubbed, no network)", () => {
  const dbs: Db[] = [];
  after(() => Promise.all(dbs.map((d) => d.close())));

  function setup(o: { net?: HushdNetwork; fail?: () => boolean; clock?: { t: number } } = {}) {
    const asked: { url: string; body: Record<string, unknown> }[] = [];
    const clock = o.clock ?? { t: 10_000 * MIN };
    const stub: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      asked.push({ url: String(input), body });
      if (o.fail?.()) return new Response("busy", { status: 503 });
      if (body.type === "allMids") return Response.json({ BTC: "74725.5", NEAR: "3.5876", ETH: "2240.1", DOGE: "0.1" });
      const req = body.req as { coin: string; startTime: number; endTime: number };
      // one-minute candles across the window asked for, as strings like Hyperliquid's, newest last
      const out = [];
      for (let t = req.startTime - (req.startTime % MIN); t <= req.endTime; t += MIN) {
        const c = 100 + (t / MIN) % 50;
        out.push({ t, T: t + MIN - 1, s: req.coin, i: "1m", o: String(c - 1), c: String(c), h: String(c + 2), l: String(c - 3), v: "1.5", n: 9 });
      }
      return Response.json(out);
    };
    const db = new Db("postgres://localhost:1/unused");
    dbs.push(db);
    const api = buildApi(o.net ?? TESTNET, db, () => clock.t, {}, { fetch: stub });
    const get = async <T>(path: string) => {
      const r = await api.request(path);
      return { status: r.status, body: (await r.json()) as T & { error?: string } };
    };
    return { api, asked, clock, get };
  }

  test("mids are Hyperliquid mainnet's, only for the coins the desk's tokens hedge with", async () => {
    const { asked, get } = setup();
    const r = await get<MarketMids>("/v1/market/mids");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { source: "hyperliquid", at: 10_000 * MIN, mids: { NEAR: 3.5876, BTC: 74_725.5 } });
    assert.deepEqual(asked.map((x) => [x.url, x.body.type]), [["https://api.hyperliquid.xyz/info", "allMids"]]);
  });

  test("the same routes answer on mainnet, still from Hyperliquid mainnet", async () => {
    const { asked, get } = setup({ net: MAINNET });
    assert.deepEqual(Object.keys((await get<MarketMids>("/v1/market/mids")).body.mids), ["NEAR", "BTC"]);
    const c = await get<MarketCandles>("/v1/market/candles?coin=NEAR&interval=1h&limit=3");
    assert.equal(c.status, 200);
    assert.equal(c.body.candles.length, 3);
    assert.ok(asked.every((x) => x.url === "https://api.hyperliquid.xyz/info"));
  });

  test("candles come as numbers, oldest first, the last `limit` of 500 read per coin and size", async () => {
    const { asked, get, clock } = setup();
    const r = await get<MarketCandles>("/v1/market/candles?coin=BTC&interval=5m&limit=120");
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.source, r.body.coin, r.body.interval, r.body.at, r.body.candles.length], ["hyperliquid", "BTC", "5m", clock.t, 120]);
    const req = asked[0]!.body.req as Record<string, unknown>;
    assert.deepEqual(req, { coin: "BTC", interval: "5m", startTime: clock.t - 500 * 5 * MIN, endTime: clock.t });
    const last = r.body.candles.at(-1)!;
    assert.deepEqual(Object.keys(last), ["t", "o", "h", "l", "c", "v"]);
    assert.equal(last.t, clock.t);
    assert.equal(last.h - last.c, 2);
    assert.ok(r.body.candles.every((c, i, all) => i === 0 || c.t > all[i - 1]!.t));
    // the default is 200
    assert.equal((await get<MarketCandles>("/v1/market/candles?coin=BTC&interval=5m")).body.candles.length, 200);
  });

  test("answers are kept a few seconds, and one read serves requests that arrive together", async () => {
    const { api, asked, get, clock } = setup();
    await Promise.all([get("/v1/market/mids"), get("/v1/market/mids"), api.request("/v1/market/mids")]);
    assert.equal(asked.length, 1);
    clock.t += 2_000;
    await get("/v1/market/mids");
    assert.equal(asked.length, 1);
    clock.t += 1_500;
    await get("/v1/market/mids");
    assert.equal(asked.length, 2);

    await get("/v1/market/candles?coin=BTC&interval=1m&limit=10");
    await get("/v1/market/candles?coin=BTC&interval=1m&limit=60");
    assert.equal(asked.length, 3, "one read per coin and size, whatever the limit");
    await get("/v1/market/candles?coin=NEAR&interval=1m");
    await get("/v1/market/candles?coin=BTC&interval=1h");
    assert.equal(asked.length, 5);
    clock.t += 5_000;
    await get("/v1/market/candles?coin=BTC&interval=1m");
    assert.equal(asked.length, 6);
  });

  test("while Hyperliquid is down the last answer is served with its time; with none, a 502 in words", async () => {
    let down = false;
    const { get, clock } = setup({ fail: () => down });
    const first = await get<MarketMids>("/v1/market/mids");
    down = true;
    clock.t += 60_000;
    const again = await get<MarketMids>("/v1/market/mids");
    assert.equal(again.status, 200);
    assert.equal(again.body.at, first.body.at);
    const none = await get("/v1/market/candles?coin=BTC&interval=4h");
    assert.equal(none.status, 502);
    assert.equal(none.body.error, "Hyperliquid candles are unavailable: Hyperliquid answered 503");
  });

  test("anything but a listed coin, a known size and a limit up to 500 is refused before Hyperliquid is asked", async () => {
    const { asked, get } = setup();
    for (const [q, words] of [
      ["coin=DOGE&interval=5m", "coin is one of NEAR, BTC"],
      ["interval=5m", "coin is one of NEAR, BTC"],
      ["coin=btc&interval=5m", "coin is one of NEAR, BTC"],
      ["coin=BTC&interval=2m", "interval is one of 1m, 5m, 15m, 1h, 4h, 1d"],
      ["coin=BTC&interval=5m&limit=0", "limit is a whole number from 1 to 500"],
      ["coin=BTC&interval=5m&limit=501", "limit is a whole number from 1 to 500"],
      ["coin=BTC&interval=5m&limit=1.5", "limit is a whole number from 1 to 500"],
    ] as const) {
      const r = await get(`/v1/market/candles?${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, words, q);
    }
    assert.equal(asked.length, 0);
  });

  test("candles that do not parse are left out", () => {
    const ok = { t: 1, o: "1", h: "2", l: "0.5", c: "1.5", v: "3" };
    assert.deepEqual(parseCandles([{ ...ok, t: 2 }, { ...ok, c: "x" }, { ...ok, c: "0" }, ok]), [
      { t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 },
      { t: 2, o: 1, h: 2, l: 0.5, c: 1.5, v: 3 },
    ]);
    assert.throws(() => parseCandles({ error: "x" }), /other than candles/);
  });
});

test("a trade's floor comes from the mids less the slippage, and is never made up", () => {
  const usdc = TESTNET.tokens.find((t) => t.symbol === "USDC")!;
  const btc = TESTNET.tokens.find((t) => t.symbol === "BTC")!;
  const wnear = TESTNET.tokens.find((t) => t.symbol === "wNEAR")!;
  const m = { BTC: 100_000, NEAR: 4 };
  assert.equal(minReceiveAt(m, usdc, 500, btc), "0.00485000");
  assert.equal(minReceiveAt(m, wnear, 5, btc, 100), "0.00019800");
  assert.equal(minReceiveAt(m, usdc, 2000, wnear), "485.00000000");
  assert.throws(() => minReceiveAt({ BTC: 100_000 }, usdc, 10, wnear), /No mid price for wNEAR/);
  assert.throws(() => minReceiveAt(m, usdc, 0.000001, btc), /too small/);
});
