/**
 * The markets the Trade screen shows: every pair of the desk's tokens (`NETWORK.tokens`).
 * A token with a Hyperliquid coin is priced by that coin in USD; the token without one is
 * the dollar stablecoin and counts as 1 USD, as the reference makers price it. A pair of two
 * priced tokens is a cross rate: one coin's price over the other's.
 */
import type { CandleInterval, MarketMids, TokenInfo } from "@hushd/sdk";
import { TOKENS } from "@/lib/hushd/format";

export interface Pair {
  id: string;
  base: TokenInfo;
  quote: TokenInfo;
  /** "BTC/USDC" */
  label: string;
  /** The Hyperliquid coins behind it: the base's, and the quote's for a cross rate. */
  baseCoin: string;
  quoteCoin: string | null;
}

const priced = TOKENS.filter((t) => t.hedgeCoin);
/** The dollar side of the desk: the listed token with no Hyperliquid coin. */
export const STABLE: TokenInfo | undefined = TOKENS.find((t) => !t.hedgeCoin);

const pair = (base: TokenInfo, quote: TokenInfo): Pair => ({
  id: `${base.symbol}-${quote.symbol}`,
  base,
  quote,
  label: `${base.symbol}/${quote.symbol}`,
  baseCoin: base.hedgeCoin!,
  quoteCoin: quote.hedgeCoin ?? null,
});

/** Dollar pairs first, the token listed last first (BTC before wNEAR), then the cross rates. */
export const PAIRS: Pair[] = [
  ...(STABLE ? [...priced].reverse().map((t) => pair(t, STABLE)) : []),
  ...priced.flatMap((q, i) => priced.slice(i + 1).map((b) => pair(b, q))),
];

export const pairById = (id: string | null | undefined) => PAIRS.find((p) => p.id === id) ?? PAIRS[0]!;

/** What a pair's price is, in words. */
export function pairSource(p: Pair): string {
  return p.quoteCoin ? `${p.baseCoin} ÷ ${p.quoteCoin} on Hyperliquid` : `${p.baseCoin} perp mid on Hyperliquid`;
}

/** USD per whole token: the stablecoin is 1, a priced token its coin's mid; null without a mid. */
export function usdOf(t: TokenInfo, mids: MarketMids["mids"] | null): number | null {
  if (!t.hedgeCoin) return 1;
  const m = mids?.[t.hedgeCoin];
  return m && m > 0 ? m : null;
}

/** The pair's price now from the mids: quote per base. */
export function pairMid(p: Pair, mids: MarketMids["mids"] | null): number | null {
  const b = usdOf(p.base, mids);
  const q = usdOf(p.quote, mids);
  return b !== null && q !== null ? b / q : null;
}

export const INTERVALS: { value: CandleInterval; label: string }[] = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1h" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1D" },
];

export const INTERVAL_WORDS: Record<CandleInterval, string> = {
  "1m": "one-minute",
  "5m": "five-minute",
  "15m": "fifteen-minute",
  "1h": "hourly",
  "4h": "four-hour",
  "1d": "daily",
};

/** Decimals that show five significant figures of a price this size, as Hyperliquid quotes. */
export function priceDecimals(ref: number): number {
  if (!Number.isFinite(ref) || ref <= 0) return 2;
  return Math.max(0, Math.min(8, 4 - Math.floor(Math.log10(ref))));
}

export function fmtPrice(v: number, ref = v): string {
  const d = priceDecimals(ref);
  return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** "+0.42%" with a true minus sign. */
export function fmtPct(f: number, decimals = 2): string {
  const s = (Math.abs(f) * 100).toFixed(decimals);
  return `${f > 0 ? "+" : f < 0 ? "−" : ""}${s}%`;
}

export function fmtUsd(v: number): string {
  const abs = Math.abs(v);
  const d = abs >= 1000 ? 0 : 2;
  return `${v < 0 ? "−" : ""}$${abs.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

/** Volume in a coin, short: 1.2K, 3.4M. */
export function fmtVolume(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  if (v >= 100) return v.toFixed(0);
  return v.toFixed(2);
}

/** "12 s ago", "3 min ago". */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** A float of whole tokens from base units, for prices and charts only (never for amounts sent). */
export const whole = (t: TokenInfo, amount: bigint | string) => Number(BigInt(amount)) / 10 ** t.decimals;
