/**
 * Market data for a trader: Hyperliquid mainnet prices (public data, the same the reference
 * makers price from), read through the Hushd API so a browser only ever talks to one host,
 * on testnet and on mainnet alike. Plus the arithmetic a trading screen needs: a cross rate
 * between two coins, and the last hour's change, range and realized volatility.
 */

/** The candle sizes the API serves. */
export const CANDLE_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

export const INTERVAL_MS: Record<CandleInterval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** One candle of a Hyperliquid perp, in USD: open time (ms), open, high, low, close, volume in the coin. */
export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MarketCandles {
  source: "hyperliquid";
  coin: string;
  interval: CandleInterval;
  /** When the API last read these from Hyperliquid (ms). */
  at: number;
  /** Oldest first; the last one is still open. */
  candles: Candle[];
}

export interface MarketMids {
  source: "hyperliquid";
  /** When the API last read these from Hyperliquid (ms). */
  at: number;
  /** USD mid price by Hyperliquid coin ("BTC", "NEAR"), for the coins the desk's tokens hedge with. */
  mids: Record<string, number>;
}

/** The API's market routes: `/v1/market/mids` and `/v1/market/candles`. */
export class MarketApi {
  // browsers refuse `fetch` called as a method of another object ("Illegal invocation"), so wrap it
  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, { signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `API answered ${res.status}`);
    return json;
  }

  mids(): Promise<MarketMids> {
    return this.get<MarketMids>("/v1/market/mids");
  }

  /** The last `limit` candles of `coin` (at most 500), oldest first. */
  candles(coin: string, interval: CandleInterval, limit?: number): Promise<MarketCandles> {
    const q = new URLSearchParams({ coin, interval, ...(limit !== undefined ? { limit: String(limit) } : {}) });
    return this.get<MarketCandles>(`/v1/market/candles?${q}`);
  }
}

/** A price at a time: a candle's close, or a cross rate. */
export interface PricePoint {
  t: number;
  v: number;
}

/** The closes of a candle series. */
export function candleCloses(candles: readonly Candle[]): PricePoint[] {
  return candles.map((c) => ({ t: c.t, v: c.c }));
}

/**
 * The price of `base` in `quote` at each time both have a candle: base close ÷ quote close.
 * Only closes are divided, since the high of a ratio is not the ratio of the highs.
 */
export function crossRate(base: readonly Candle[], quote: readonly Candle[]): PricePoint[] {
  const q = new Map(quote.map((c) => [c.t, c.c]));
  return base.flatMap((b) => {
    const d = q.get(b.t);
    return d && d > 0 && b.c > 0 ? [{ t: b.t, v: b.c / d }] : [];
  });
}

/**
 * Realized volatility of closes taken one minute apart, in basis points per hour: the
 * standard deviation of their log returns times sqrt(60) times 10,000. Null with fewer
 * than 10 closes. The volatility maker prices with this number.
 */
export function realizedVolBps(values: readonly number[], periodsPerHour = 60): number | null {
  const xs = values.filter((x) => Number.isFinite(x) && x > 0);
  if (xs.length < 10) return null;
  const rets = xs.slice(1).map((c, i) => Math.log(c / xs[i]!));
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
  return sd * Math.sqrt(periodsPerHour) * 10_000;
}

export interface HourStats {
  /** The latest value. */
  last: number;
  /** Change since an hour before the latest point, as a fraction (0.01 is 1%); null when the series is shorter. */
  change: number | null;
  /** Highest and lowest in the last hour: candle highs and lows, or values for a cross rate. */
  high: number;
  low: number;
  /** Realized volatility over the last hour (`realizedVolBps`). */
  volBps: number | null;
}

const HOUR = 3_600_000;

/** The last hour of a one-minute series: candles (with true highs and lows) or price points. */
export function hourStats(series: readonly Candle[] | readonly PricePoint[]): HourStats | null {
  const pts: { t: number; v: number; h: number; l: number }[] = series.map((x) => ("c" in x ? { t: x.t, v: x.c, h: x.h, l: x.l } : { t: x.t, v: x.v, h: x.v, l: x.v }));
  const last = pts.at(-1);
  if (!last) return null;
  const from = last.t - HOUR;
  const before = pts.filter((p) => p.t <= from).at(-1);
  const hour = pts.filter((p) => p.t > from);
  return {
    last: last.v,
    change: before && before.v > 0 ? last.v / before.v - 1 : null,
    high: Math.max(...hour.map((p) => p.h)),
    low: Math.min(...hour.map((p) => p.l)),
    volBps: realizedVolBps(hour.map((p) => p.v)),
  };
}
