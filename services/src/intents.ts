/**
 * NEAR Intents 1Click for the app: deposits into Hushd from other chains and cash-outs to
 * them, previewed with live dry quotes, and the record of the mainnet trades between our agents.
 *
 * - `GET /v1/intents/tokens`: what 1Click can route, by chain (NEAR left out: it is the Hushd
 *   side), plus the mainnet token each Hushd test token stands for. Cached ten minutes.
 * - `POST /v1/intents/quote`: always a dry quote, so nothing is reserved, no deposit address
 *   is made and nothing is sent. 1Click runs on mainnet only and Hushd's pool on testnet, so
 *   the NEAR side of a preview is the all-zero implicit account. With a partner key
 *   (`ONECLICK_API_KEY`) the quote asks for confidentiality, and says so in `confidential`.
 * - `GET /v1/intents/trades`: `deployments/mainnet-intents.json`, written by
 *   `scripts/intents-mainnet.ts`, or no steps while that has not run.
 */
import { readFile } from "node:fs/promises";
import { formatUnits } from "@hushd/protocol";
import { OneClick, quoteRequest, type OneClickToken, type QuoteRequest, type QuoteResponse } from "@hushd/sdk";
import type { Hono } from "hono";
import { settings } from "./config.js";
import { BadRequest, rateLimit } from "./http.js";
import { INTENTS_ASSET } from "./market.js";

/** The NEAR account on the Hushd side of every preview: the implicit account of no key anyone holds. */
export const PREVIEW_ACCOUNT = "0".repeat(64);
const SLIPPAGE_BPS = 100;
const TOKENS_TTL_MS = 10 * 60_000;
const RECORD = new URL("../../deployments/mainnet-intents.json", import.meta.url).pathname;

/**
 * Display names for some of 1Click's chain codes. A code not listed shows as itself: in capitals
 * when it is short like a ticker ("op", "pol"), else with a capital first letter ("plasma").
 */
const CHAIN_NAMES: Record<string, string> = {
  abs: "Abstract",
  adi: "ADI Chain",
  aleo: "Aleo",
  arb: "Arbitrum",
  avax: "Avalanche",
  base: "Base",
  bch: "Bitcoin Cash",
  bera: "Berachain",
  bsc: "BNB Chain",
  btc: "Bitcoin",
  dash: "Dash",
  doge: "Dogecoin",
  eth: "Ethereum",
  fogo: "Fogo",
  hlevm: "HyperEVM",
  hood: "Robinhood Chain",
  hypercore: "Hyperliquid",
  ltc: "Litecoin",
  near: "NEAR",
  op: "Optimism",
  pol: "Polygon",
  sol: "Solana",
  sui: "Sui",
  ton: "TON",
  tron: "TRON",
  xlayer: "X Layer",
  xrp: "XRP Ledger",
  zec: "Zcash",
};
export const chainName = (code: string) => CHAIN_NAMES[code] ?? (code.length <= 4 ? code.toUpperCase() : `${code[0]!.toUpperCase()}${code.slice(1)}`);

/** The assets people look for first; the rest of a chain's list follows alphabetically. */
const FIRST = ["USDC", "USDT", "ETH", "BTC", "SOL", "NEAR", "wNEAR"];
const rank = (symbol: string) => {
  const i = FIRST.indexOf(symbol);
  return i < 0 ? FIRST.length : i;
};

export interface IntentsToken {
  assetId: string;
  symbol: string;
  decimals: number;
  /** USD, from 1Click; null when it has none. */
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
  /** The mainnet asset each Hushd token stands for, by the Hushd token's symbol. */
  hushd: IntentsToken[];
}

const trim = (t: OneClickToken): IntentsToken => ({ assetId: t.assetId, symbol: t.symbol, decimals: t.decimals, price: typeof t.price === "number" && Number.isFinite(t.price) ? t.price : null });

/** 1Click's list, grouped by chain and sorted: chains by name, assets by `FIRST` then symbol. */
export function groupTokens(list: OneClickToken[], at: number): IntentsTokens {
  const byChain = new Map<string, IntentsToken[]>();
  for (const t of list) {
    if (t.blockchain === "near" || /deprecated/i.test(t.symbol)) continue;
    byChain.set(t.blockchain, [...(byChain.get(t.blockchain) ?? []), trim(t)]);
  }
  const chains = [...byChain.entries()]
    .map(([id, tokens]) => ({
      id,
      name: chainName(id),
      tokens: tokens.sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol, "en", { sensitivity: "base" })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  const hushd = Object.entries(INTENTS_ASSET).flatMap(([symbol, assetId]) => {
    const t = list.find((x) => x.assetId === assetId);
    return t ? [{ ...trim(t), symbol }] : [];
  });
  return { updatedAt: new Date(at).toISOString(), chains, hushd };
}

/** What the routes need from outside, so tests can stand in for 1Click and the record. */
export interface IntentsDeps {
  fetch?: typeof fetch;
  now?: () => number;
  recordPath?: string;
}

type Side = IntentsToken & { chain: string; chainName: string };
/** What 1Click echoes beyond the SDK's types. */
type Echo = Omit<QuoteResponse, "quoteRequest" | "quote"> & {
  correlationId?: string;
  quoteRequest: Omit<QuoteRequest, "confidentiality"> & { confidentiality?: string; depositMode?: string; appFees?: { recipient: string; fee: number }[] };
  quote: QuoteResponse["quote"] & { withdrawFee?: string; refundFee?: string };
};
export type IntentsQuote = Echo & { confidential: boolean; direction: "deposit" | "cashout"; nearAccount: string; from: Side; to: Side };

const REFUSED = /^1Click answered (\d{3}): ([\s\S]*)$/;

/** 1Click's refusal of a quote, in words for the person who asked for it. */
export function plainQuoteError(detail: string, o: { direction: "deposit" | "cashout"; from: Side; to: Side }): string {
  const other = o.direction === "deposit" ? o.from : o.to;
  if (/^refundTo is not valid/i.test(detail)) return `That is not a valid ${other.chainName} address. 1Click sends the ${o.from.symbol} back to it if the swap cannot be filled.`;
  if (/^recipient is not valid/i.test(detail)) return `That is not a valid ${other.chainName} address to receive ${o.to.symbol} on.`;
  const low = /amount is too low.*?at least (\d+)/i.exec(detail);
  if (low) return `That is too little for this route. ${o.direction === "deposit" ? "Send" : "Cash out"} at least ${formatUnits(BigInt(low[1]!), o.from.decimals)} ${o.from.symbol}.`;
  if (/no liquidity/i.test(detail)) return "No solver can fill that amount right now. Try a smaller one.";
  if (/failed to get quote/i.test(detail)) return "No solver quoted this route just now. Try another amount, or again in a moment.";
  return /[.!?]$/.test(detail) ? detail : `${detail}.`;
}

export function intentsRoutes(a: Hono, deps: IntentsDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const base = () => settings.str("ONECLICK_URL", "https://1click.chaindefuser.com");
  const key = () => settings.str("ONECLICK_API_KEY", "");
  const client = (withKey: boolean) => new OneClick(base(), withKey ? key() || undefined : undefined, fetchImpl, 15_000);

  let tokens: { at: number; data: IntentsTokens } | null = null;
  let loading: Promise<IntentsTokens> | null = null;
  const tokenList = async (): Promise<IntentsTokens> => {
    if (tokens && now() - tokens.at < TOKENS_TTL_MS) return tokens.data;
    loading ??= client(false)
      .tokens()
      .then((list) => {
        const at = now();
        tokens = { at, data: groupTokens(list, at) };
        return tokens.data;
      })
      .catch((e: Error) => {
        // an old list beats none while 1Click is unreachable
        if (tokens) return tokens.data;
        throw e;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  a.get("/v1/intents/tokens", async (c) => {
    try {
      return c.json(await tokenList());
    } catch (e) {
      return c.json({ error: `The 1Click token list is unavailable: ${(e as Error).message}` }, 502);
    }
  });

  a.post("/v1/intents/quote", rateLimit(60), async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") throw new BadRequest("The body is JSON: direction, asset, token, amount, address");
    const { direction, asset, token, amount, address } = b;
    if (direction !== "deposit" && direction !== "cashout") throw new BadRequest('direction is "deposit" (from another chain) or "cashout" (to another chain)');
    if (typeof amount !== "string" || !/^\d{1,40}$/.test(amount) || BigInt(amount) === 0n) throw new BadRequest("amount is a whole number of the sent asset's smallest unit, above zero");
    if (typeof address !== "string" || address.trim() === "" || address.length > 128 || /\s/.test(address.trim())) throw new BadRequest("address is your address on the other chain");
    if (typeof asset !== "string" || typeof token !== "string") throw new BadRequest("asset is a 1Click asset id; token is the Hushd token's symbol");

    let list: IntentsTokens;
    try {
      list = await tokenList();
    } catch (e) {
      return c.json({ error: `The 1Click token list is unavailable: ${(e as Error).message}` }, 502);
    }
    const chain = list.chains.find((ch) => ch.tokens.some((t) => t.assetId === asset));
    const t = chain?.tokens.find((x) => x.assetId === asset);
    if (!chain || !t) throw new BadRequest("asset is not one 1Click routes from another chain (see /v1/intents/tokens)");
    const h = list.hushd.find((x) => x.symbol === token);
    if (!h) throw new BadRequest(`token is one of ${list.hushd.map((x) => x.symbol).join(", ")}`);
    const otherSide: Side = { ...t, chain: chain.id, chainName: chain.name };
    const hushdSide: Side = { ...h, chain: "near", chainName: "NEAR" };
    const [from, to] = direction === "deposit" ? [otherSide, hushdSide] : [hushdSide, otherSide];
    const you = address.trim();

    const request = (confidential: boolean) => ({
      ...quoteRequest({
        originAsset: from.assetId,
        destinationAsset: to.assetId,
        amount,
        refundTo: direction === "deposit" ? you : PREVIEW_ACCOUNT,
        recipient: direction === "deposit" ? PREVIEW_ACCOUNT : you,
        slippageTolerance: SLIPPAGE_BPS,
        ...(confidential ? { confidentiality: "basic" as const } : {}),
      }),
      // Stellar deposits carry a memo; 1Click refuses a plain address for them
      ...(from.chain === "stellar" ? { depositMode: "MEMO" } : {}),
      // a preview, whatever the caller sent
      dry: true,
    });

    const ask = async (confidential: boolean) => (await client(confidential).quote(request(confidential))) as unknown as Echo;
    let res: Echo;
    let confidential = Boolean(key());
    try {
      try {
        res = await ask(confidential);
      } catch (e) {
        const status = Number(REFUSED.exec((e as Error).message)?.[1]);
        if (!confidential || (status !== 401 && status !== 403)) throw e;
        // the partner key was refused: a public quote still shows the route, and says it is public
        console.error(`api: 1Click refused the partner key (${(e as Error).message}); quoting publicly`);
        confidential = false;
        res = await ask(false);
      }
    } catch (e) {
      const m = REFUSED.exec((e as Error).message);
      if (m && m[1] === "400") throw new BadRequest(plainQuoteError(m[2]!.trim(), { direction, from, to }));
      return c.json({ error: `1Click did not answer with a quote: ${m ? m[2] : (e as Error).message}` }, 502);
    }
    const body: IntentsQuote = {
      ...res,
      confidential: confidential && res.quoteRequest?.confidentiality !== undefined && res.quoteRequest.confidentiality !== "public",
      direction,
      nearAccount: PREVIEW_ACCOUNT,
      from,
      to,
    };
    return c.json(body);
  });

  a.get("/v1/intents/trades", async (c) => {
    let raw: string;
    try {
      raw = await readFile(deps.recordPath ?? RECORD, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return c.json({ steps: [] });
      throw e;
    }
    const record = JSON.parse(raw) as { steps?: unknown };
    return c.json(Array.isArray(record.steps) ? record : { ...record, steps: [] });
  });
}
