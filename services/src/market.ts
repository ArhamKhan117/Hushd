/**
 * Live market data for the makers: Hyperliquid mid prices and recent volatility,
 * Hyperliquid's perp metadata and number formats for hedge orders, and NEAR Intents
 * (1Click) dry quotes as a second price: what the open market would pay right now.
 * Prices come from mainnet (public data, no account, nothing is traded); hedge orders
 * go to Hyperliquid testnet, or mainnet when Hushd runs on mainnet (`hedgeTestnet`).
 *
 * The API serves the same prices to the app (`marketRoutes`), so a trader sees what the
 * makers price from without the browser calling Hyperliquid itself.
 */
import { CANDLE_INTERVALS, INTERVAL_MS, OneClick, quoteRequest, realizedVolBps, type Candle, type CandleInterval, type HushdNetwork, type MarketCandles, type MarketMids, type TokenInfo } from "@hushd/sdk";
import type { Hono } from "hono";
import { settings } from "./config.js";
import { BadRequest } from "./http.js";

const HL_MAIN = () => settings.str("HYPERLIQUID_INFO_URL", "https://api.hyperliquid.xyz/info");
const HL_TEST = () => settings.str("HYPERLIQUID_TESTNET_INFO_URL", "https://api.hyperliquid-testnet.xyz/info");

/** Hedge orders go to Hyperliquid testnet unless HYPERLIQUID_NETWORK=mainnet; it follows HUSHD_NETWORK by default. */
export const hedgeTestnet = () => settings.str("HYPERLIQUID_NETWORK", settings.str("HUSHD_NETWORK", "testnet")) !== "mainnet";
const HL_HEDGE = () => (hedgeTestnet() ? HL_TEST() : HL_MAIN());

async function info<T>(url: string, body: object): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`Hyperliquid answered ${r.status}`);
  return (await r.json()) as T;
}

let midsCache: { at: number; mids: Record<string, number> } | null = null;

/** USD mid prices by coin ("BTC", "NEAR", ...), cached for 3 seconds. */
export async function mids(): Promise<Record<string, number>> {
  if (midsCache && Date.now() - midsCache.at < 3_000) return midsCache.mids;
  const raw = await info<Record<string, string>>(HL_MAIN(), { type: "allMids" });
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) out[k] = Number(v);
  midsCache = { at: Date.now(), mids: out };
  return out;
}

/**
 * The least to accept for `amount` of `sell` paid in `buy` at mid prices `m`, less
 * `slippageBps`: a trade's `min_receive`, in `buy`'s own units ("0.0063"). Throws when a
 * mid is missing, so a floor is never made up.
 */
export function minReceiveAt(m: Record<string, number>, sell: TokenInfo, amount: number, buy: TokenInfo, slippageBps = 300): string {
  const usd = (t: TokenInfo) => (t.symbol === "USDC" ? 1 : t.hedgeCoin ? m[t.hedgeCoin] : undefined);
  const sellUsd = usd(sell);
  const buyUsd = usd(buy);
  if (!sellUsd || !buyUsd) throw new Error(`No mid price for ${sellUsd ? buy.symbol : sell.symbol}`);
  const text = (((amount * sellUsd) / buyUsd) * (1 - slippageBps / 10_000)).toFixed(Math.min(buy.decimals, 8));
  if (!(Number(text) > 0)) throw new Error(`${amount} ${sell.symbol} is too small to price in ${buy.symbol}`);
  return text;
}

/** Realized volatility over the last hour from 1-minute candles, in basis points. */
export async function hourVolBps(coin: string): Promise<number> {
  const end = Date.now();
  const candles = await info<{ c: string }[]>(HL_MAIN(), { type: "candleSnapshot", req: { coin, interval: "1m", startTime: end - 3_600_000, endTime: end } });
  // the app shows the same measure (`hourStats` in the SDK); with too few closes, assume 50 bps
  return realizedVolBps(candles.map((c) => Number(c.c))) ?? 50;
}

export interface PerpMeta {
  asset: number;
  szDecimals: number;
  maxLeverage: number;
}

let metaCache: Record<string, PerpMeta> | null = null;
/** The perp universe of the Hyperliquid network hedges go to: asset index and size decimals by coin. */
export async function hedgePerps(): Promise<Record<string, PerpMeta>> {
  if (metaCache) return metaCache;
  const m = await info<{ universe: { name: string; szDecimals: number; maxLeverage: number }[] }>(HL_HEDGE(), { type: "meta" });
  metaCache = Object.fromEntries(m.universe.map((u, i) => [u.name, { asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }]));
  return metaCache;
}

/** USDC an account can still put up as margin where hedges go (0 when the account does not exist). */
export async function hedgeWithdrawable(address: string): Promise<number> {
  const s = await info<{ withdrawable?: string }>(HL_HEDGE(), { type: "clearinghouseState", user: address });
  return Number(s.withdrawable ?? 0);
}

/** Hyperliquid wire format: no trailing zeros, no exponent. */
function wire(x: number, decimals: number): string {
  const s = x.toFixed(decimals);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** A size rounded down to the coin's size decimals. */
export function wireSize(size: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return wire(Math.floor(size * f) / f, szDecimals);
}

/** A perp price: at most 5 significant figures and 6 - szDecimals decimals. */
export function wirePrice(px: number, szDecimals: number): string {
  const sig = Number(px.toPrecision(5));
  return wire(sig, Math.max(0, 6 - szDecimals));
}

/** USD value per whole unit of a Hushd test token, from its hedge coin (USDC is 1). */
export async function usdPrice(symbol: string, coin?: string): Promise<number> {
  if (symbol === "USDC") return 1;
  const m = await mids();
  const px = coin ? m[coin] : undefined;
  if (!px) throw new Error(`no price for ${symbol}`);
  return px;
}

const ONECLICK = () => settings.str("ONECLICK_URL", "https://1click.chaindefuser.com").replace(/\/$/, "");

/** The NEAR Intents asset each test token stands for (same decimals). */
export const INTENTS_ASSET: Record<string, string> = {
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  wNEAR: "nep141:wrap.near",
  BTC: "nep141:nbtc.bridge.near",
};

const intentsCache = new Map<string, { at: number; out: bigint }>();

/**
 * What 1Click would pay out for `amount` of `sell` in `buy` right now: a dry quote
 * (nothing is deposited or traded), cached for 15 seconds per pair and size.
 */
export async function intentsQuote(sellSymbol: string, buySymbol: string, amount: bigint): Promise<bigint | null> {
  const origin = INTENTS_ASSET[sellSymbol];
  const destination = INTENTS_ASSET[buySymbol];
  if (!origin || !destination) return null;
  const key = `${sellSymbol}>${buySymbol}:${amount}`;
  const hit = intentsCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.out;
  const q = await new OneClick(ONECLICK(), settings.str("ONECLICK_API_KEY", "") || undefined, undefined, 8_000).quote(
    quoteRequest({ originAsset: origin, destinationAsset: destination, amount: amount.toString(), recipient: "intents.near", refundTo: "intents.near", depositType: "INTENTS", refundType: "INTENTS", recipientType: "INTENTS", quoteWaitingTimeMs: 2_000 }),
  );
  const out = BigInt(q.quote.amountOut);
  intentsCache.set(key, { at: Date.now(), out });
  return out;
}

/** Never give more than the open market would, less our spread: min(Hyperliquid price, 1Click price). */
export function capByMarket(give: bigint, marketOut: bigint | null, spreadBps: number): bigint {
  if (marketOut === null) return give;
  const capped = (marketOut * BigInt(10_000 - spreadBps)) / 10_000n;
  return capped < give ? capped : give;
}

/** What the market routes need from outside, so tests can stand in for Hyperliquid and the clock. */
export interface MarketDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

const MIDS_TTL_MS = 3_000;
const CANDLES_TTL_MS = 5_000;
/** Candles read per coin and size; a request takes the last `limit` of them. */
const MAX_CANDLES = 500;

interface HlCandle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

/** Hyperliquid's candles as numbers, oldest first, without any that do not parse. */
export function parseCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new Error("Hyperliquid answered something other than candles");
  return (raw as HlCandle[])
    .map((x) => ({ t: Number(x.t), o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c), v: Number(x.v) }))
    .filter((x) => [x.t, x.o, x.h, x.l, x.c, x.v].every(Number.isFinite) && x.c > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Read-only market routes for the app, from Hyperliquid mainnet, for the coins the network's
 * tokens hedge with (only those: the API is not an open proxy):
 *
 * - `GET /v1/market/mids`: USD mid prices, cached three seconds.
 * - `GET /v1/market/candles?coin=BTC&interval=5m&limit=200`: the last `limit` candles (at most
 *   500), cached five seconds per coin and size.
 *
 * One read to Hyperliquid at a time per key; while Hyperliquid is unreachable the last answer
 * is served with the time it was read (`at`), and with none yet the route answers 502.
 */
export function marketRoutes(a: Hono, net: HushdNetwork, deps: MarketDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const coins = [...new Set(net.tokens.flatMap((t) => (t.hedgeCoin ? [t.hedgeCoin] : [])))];

  const ask = async (body: object): Promise<unknown> => {
    const r = await fetchImpl(HL_MAIN(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`Hyperliquid answered ${r.status}`);
    return r.json();
  };

  const kept = new Map<string, { at: number; data: unknown }>();
  const loading = new Map<string, Promise<{ at: number; data: unknown }>>();
  async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<{ at: number; data: T }> {
    const hit = kept.get(key);
    if (hit && now() - hit.at < ttlMs) return hit as { at: number; data: T };
    let p = loading.get(key);
    if (!p) {
      p = load()
        .then((data) => {
          const v = { at: now(), data };
          kept.set(key, v);
          return v;
        })
        .catch((e: Error) => {
          // an older answer beats none while Hyperliquid is unreachable
          if (hit) {
            console.error(`api: Hyperliquid read for ${key} failed (${e.message}); serving the one from ${new Date(hit.at).toISOString()}`);
            return hit;
          }
          throw e;
        })
        .finally(() => loading.delete(key));
      loading.set(key, p);
    }
    return p as Promise<{ at: number; data: T }>;
  }

  a.get("/v1/market/mids", async (c) => {
    try {
      const { at, data } = await cached("mids", MIDS_TTL_MS, async () => {
        const raw = (await ask({ type: "allMids" })) as Record<string, string>;
        return Object.fromEntries(coins.flatMap((k) => (Number(raw[k]) > 0 ? [[k, Number(raw[k])]] : [])));
      });
      return c.json({ source: "hyperliquid", at, mids: data } satisfies MarketMids);
    } catch (e) {
      return c.json({ error: `Hyperliquid prices are unavailable: ${(e as Error).message}` }, 502);
    }
  });

  a.get("/v1/market/candles", async (c) => {
    const coin = c.req.query("coin") ?? "";
    const interval = (c.req.query("interval") ?? "5m") as CandleInterval;
    const limitText = c.req.query("limit") ?? "200";
    if (!coins.includes(coin)) throw new BadRequest(`coin is one of ${coins.join(", ")}`);
    if (!CANDLE_INTERVALS.includes(interval)) throw new BadRequest(`interval is one of ${CANDLE_INTERVALS.join(", ")}`);
    if (!/^\d{1,3}$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > MAX_CANDLES) throw new BadRequest(`limit is a whole number from 1 to ${MAX_CANDLES}`);
    try {
      const { at, data } = await cached(`candles:${coin}:${interval}`, CANDLES_TTL_MS, async () => {
        const end = now();
        return parseCandles(await ask({ type: "candleSnapshot", req: { coin, interval, startTime: end - MAX_CANDLES * INTERVAL_MS[interval], endTime: end } }));
      });
      return c.json({ source: "hyperliquid", coin, interval, at, candles: data.slice(-Number(limitText)) } satisfies MarketCandles);
    } catch (e) {
      return c.json({ error: `Hyperliquid candles are unavailable: ${(e as Error).message}` }, 502);
    }
  });
}
