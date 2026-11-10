/** Market data: the API client, cross rates and the last hour's numbers. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { candleCloses, crossRate, hourStats, MarketApi, realizedVolBps, type Candle } from "../src/market.ts";

const MIN = 60_000;
const candle = (t: number, c: number, o = c, h = Math.max(o, c), l = Math.min(o, c), v = 1): Candle => ({ t, o, h, l, c, v });

test("the client asks the API's market routes and passes its refusals on in its words", async () => {
  const asked: string[] = [];
  const stub: typeof fetch = async (input) => {
    const url = String(input);
    asked.push(url);
    if (url.includes("coin=DOGE")) return new Response(JSON.stringify({ error: "coin is one of NEAR, BTC" }), { status: 400 });
    if (url.endsWith("/v1/market/mids")) return Response.json({ source: "hyperliquid", at: 5, mids: { BTC: 74_000.5 } });
    return Response.json({ source: "hyperliquid", coin: "BTC", interval: "5m", at: 5, candles: [candle(0, 1)] });
  };
  const api = new MarketApi("https://api.example/", stub);
  assert.deepEqual((await api.mids()).mids, { BTC: 74_000.5 });
  assert.equal((await api.candles("BTC", "5m", 120)).candles.length, 1);
  await assert.rejects(api.candles("DOGE", "1m"), /coin is one of NEAR, BTC/);
  assert.deepEqual(asked, [
    "https://api.example/v1/market/mids",
    "https://api.example/v1/market/candles?coin=BTC&interval=5m&limit=120",
    "https://api.example/v1/market/candles?coin=DOGE&interval=1m",
  ]);
});

test("a cross rate divides closes taken at the same time and skips the rest", () => {
  const btc = [candle(0, 75_000), candle(MIN, 75_300), candle(2 * MIN, 75_150)];
  const near = [candle(0, 3), candle(2 * MIN, 3.06)];
  assert.deepEqual(crossRate(btc, near), [
    { t: 0, v: 25_000 },
    { t: 2 * MIN, v: 75_150 / 3.06 },
  ]);
  assert.deepEqual(crossRate(btc, [candle(0, 0)]), []);
});

test("realized volatility is the hourly standard deviation of one-minute log returns", () => {
  assert.equal(realizedVolBps([1, 2, 3]), null);
  assert.equal(realizedVolBps(Array(30).fill(100)), 0);
  // returns alternate +r and -r: the sample deviation is r * sqrt(n / (n - 1))
  const r = 0.001;
  const xs = [100];
  for (let i = 0; i < 20; i++) xs.push(xs.at(-1)! * Math.exp(i % 2 ? -r : r));
  const expected = r * Math.sqrt(20 / 19) * Math.sqrt(60) * 10_000;
  assert.ok(Math.abs(realizedVolBps(xs)! - expected) < 1e-9);
  // non-positive values are not prices
  assert.equal(realizedVolBps([...xs, 0, -1]), realizedVolBps(xs));
});

test("the hour's change, range and volatility come from the last hour of a one-minute series", () => {
  const series: Candle[] = [];
  for (let i = 0; i <= 90; i++) series.push(candle(i * MIN, 100 + i, 100 + i - 0.5, 100 + i + 2, 100 + i - 3));
  const s = hourStats(series)!;
  assert.equal(s.last, 190);
  // an hour before the last open (90 min) is the 30 min candle, which closed at 130
  assert.equal(s.change, 190 / 130 - 1);
  // highs and lows of the 60 candles after that one
  assert.equal(s.high, 192);
  assert.equal(s.low, 131 - 3);
  assert.equal(s.volBps, realizedVolBps(series.slice(31).map((c) => c.c)));
  // a cross rate has no highs or lows of its own: its range is its values
  const cross = hourStats(candleCloses(series))!;
  assert.deepEqual([cross.high, cross.low], [190, 131]);
  // shorter than an hour: no change to report
  assert.equal(hourStats(series.slice(-30))!.change, null);
  assert.equal(hourStats([]), null);
});

test("an empty minimum becomes 3% under the market, never zero", async () => {
  const { marketFloor } = await import("../src/market.ts");
  const usdc = { symbol: "USDC", decimals: 6 };
  const btc = { symbol: "BTC", decimals: 8, hedgeCoin: "BTC" };
  const near = { symbol: "wNEAR", decimals: 24, hedgeCoin: "NEAR" };
  // 1,000 USDC at BTC 50,000: 0.02 BTC, less 3%
  assert.equal(marketFloor({ BTC: 50_000 }, usdc, 1_000_000_000n, btc), 1_940_000n);
  // 10 wNEAR at NEAR 3.5: 35 USDC, less 3%
  assert.equal(marketFloor({ NEAR: 3.5 }, near, 10n * 10n ** 24n, usdc), 33_950_000n);
  assert.throws(() => marketFloor({}, usdc, 1_000_000n, btc), /No market price for BTC/);
  assert.throws(() => marketFloor({ BTC: 50_000 }, usdc, 1n, btc), /too small/);
});
