/**
 * Live market data for the makers: Hyperliquid mid prices and recent volatility, and
 * Hyperliquid's perp metadata and number formats for hedge orders.
 * Prices come from Hyperliquid mainnet (public data, no account); hedge orders go to
 * Hyperliquid testnet.
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
