/**
 * NEAR Intents through the Hushd API: the 1Click token list by chain, dry quotes for a
 * deposit from another chain or a cash out to one, and the mainnet trades between Hushd's
 * agents. The browser only talks to the Hushd API, never to 1Click.
 */
import { API_URL } from "./config";

const API = API_URL.replace(/\/$/, "");

export interface IntentsToken {
  assetId: string;
  symbol: string;
  decimals: number;
  price: number | null;
}
export interface IntentsChain {
  id: string;
  name: string;
  tokens: IntentsToken[];
}
export interface IntentsTokens {
  updatedAt: string;
  chains: IntentsChain[];
  /** The mainnet asset each Hushd token stands for, by symbol. */
  hushd: IntentsToken[];
}

export type Direction = "deposit" | "cashout";
export type QuoteSide = IntentsToken & { chain: string; chainName: string };

export interface IntentsQuote {
  confidential: boolean;
  direction: Direction;
  nearAccount: string;
  from: QuoteSide;
  to: QuoteSide;
  timestamp: string;
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd?: string;
    minAmountOut: string;
    timeEstimate?: number;
    withdrawFee?: string;
  };
  quoteRequest: { slippageTolerance: number; appFees?: { recipient: string; fee: number }[] };
}

export interface IntentsStep {
  step: string;
  txs: string[];
  note?: string;
  at: string;
}
export interface IntentsTrades {
  network?: string;
  verifier?: string;
  explorer?: string;
  steps: IntentsStep[];
}

/** A refusal from the Hushd API, with its HTTP status (400: the request itself is wrong; trying again will not help). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("The Hushd API could not be reached just now.", 0);
  }
  const body = (await r.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!r.ok || !body) throw new ApiError(body?.error ?? `The Hushd API answered ${r.status}.`, r.status);
  return body;
}

let tokens: Promise<IntentsTokens> | null = null;

/** The token list, fetched once per page load (the API caches it for ten minutes). */
export function intentsTokens(): Promise<IntentsTokens> {
  tokens ??= call<IntentsTokens>("/v1/intents/tokens").catch((e: Error) => {
    tokens = null;
    throw e;
  });
  return tokens;
}

/** A dry quote: nothing is reserved, no deposit address is made and nothing is sent. */
export function intentsQuote(q: { direction: Direction; asset: string; token: string; amount: string; address: string }, signal?: AbortSignal): Promise<IntentsQuote> {
  return call<IntentsQuote>("/v1/intents/quote", { method: "POST", body: JSON.stringify(q), signal });
}

export function intentsTrades(): Promise<IntentsTrades> {
  return call<IntentsTrades>("/v1/intents/trades");
}

/* ---------------------------------------------------------------- words */

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$24.99", "under $0.01", or null when there is no number. */
export function usd(v: number | string | undefined | null): string | null {
  const n = typeof v === "string" ? Number(v) : v;
  if (n === undefined || n === null || !Number.isFinite(n)) return null;
  if (n > 0 && n < 0.01) return "under $0.01";
  return usdFmt.format(n);
}

/** A decimal string kept readable: thousands grouped, six decimals, or six significant digits below 1. */
export function amount(s: string): string {
  const [w = "0", f = ""] = s.split(".");
  const whole = BigInt(w || "0").toLocaleString("en-US");
  const lead = w === "0" || w === "" ? (/^0*/.exec(f)?.[0].length ?? 0) : 0;
  const frac = f.slice(0, lead + 6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** "About 35 seconds", "About 13 minutes". */
export function duration(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds)) return null;
  if (seconds < 90) return `About ${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `About ${Math.round(seconds / 60)} minutes`;
  return `About ${Math.round(seconds / 3600)} hours`;
}

/** Basis points as a percentage: 1 -> "0.01%", 20 -> "0.2%". */
export const percent = (bps: number) => `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
