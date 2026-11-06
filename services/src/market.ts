/**
 * Live market data for the makers: Hyperliquid mid prices and recent volatility,
 * Hyperliquid's perp metadata and number formats for hedge orders, and NEAR Intents
 * (1Click) dry quotes as a second price: what the open market would pay right now.
 * Prices come from mainnet (public data, no account, nothing is traded); hedge orders
 * go to Hyperliquid testnet.
 */
import { settings } from "./config.js";

const HL_MAIN = () => settings.str("HYPERLIQUID_INFO_URL", "https://api.hyperliquid.xyz/info");
const HL_TEST = () => settings.str("HYPERLIQUID_TESTNET_INFO_URL", "https://api.hyperliquid-testnet.xyz/info");

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

/** Realized volatility over the last hour from 1-minute candles, in basis points. */
export async function hourVolBps(coin: string): Promise<number> {
  const end = Date.now();
  const candles = await info<{ c: string }[]>(HL_MAIN(), { type: "candleSnapshot", req: { coin, interval: "1m", startTime: end - 3_600_000, endTime: end } });
  const closes = candles.map((c) => Number(c.c)).filter((x) => x > 0);
  if (closes.length < 10) return 50;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]!));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
  return sd * Math.sqrt(60) * 10_000;
}

export interface PerpMeta {
  asset: number;
  szDecimals: number;
}

let metaCache: Record<string, PerpMeta> | null = null;
/** Hyperliquid testnet perp universe: asset index and size decimals by coin. */
export async function testnetPerps(): Promise<Record<string, PerpMeta>> {
  if (metaCache) return metaCache;
  const m = await info<{ universe: { name: string; szDecimals: number }[] }>(HL_TEST(), { type: "meta" });
  metaCache = Object.fromEntries(m.universe.map((u, i) => [u.name, { asset: i, szDecimals: u.szDecimals }]));
  return metaCache;
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
  const jwt = settings.str("ONECLICK_JWT", "");
  const r = await fetch(`${ONECLICK()}/v0/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: JSON.stringify({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: origin,
      depositType: "INTENTS",
      destinationAsset: destination,
      amount: amount.toString(),
      refundTo: "intents.near",
      refundType: "INTENTS",
      recipient: "intents.near",
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
      quoteWaitingTimeMs: 2_000,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) throw new Error(`1Click answered ${r.status}`);
  const out = BigInt(((await r.json()) as { quote: { amountOut: string } }).quote.amountOut);
  intentsCache.set(key, { at: Date.now(), out });
  return out;
}

/** Never give more than the open market would, less our spread: min(Hyperliquid price, 1Click price). */
export function capByMarket(give: bigint, marketOut: bigint | null, spreadBps: number): bigint {
  if (marketOut === null) return give;
  const capped = (marketOut * BigInt(10_000 - spreadBps)) / 10_000n;
  return capped < give ? capped : give;
}
