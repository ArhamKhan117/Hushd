/**
 * Hushd's worker on NEAR's Agent Market (market.near.ai): "Hushd price check".
 *
 * A buyer (a person or an agent) hires it with a pair and a size ("sell 2,500 USDC for
 * NEAR"). It answers with the live NEAR Intents (1Click) quote for exactly that trade, the
 * Hyperliquid mid, the gap between them in basis points, and what Hushd's bonded makers
 * quote for it on testnet, each maker paid privately over x402 from this agent's own
 * Hushd balance: an agent hiring agents and paying them without showing who paid.
 *
 * It polls its assignments with its `aat_` token (MARKET_AGENT_TOKEN); the listing itself
 * is made by scripts/market-listing.ts, and goes live only with the owner's go-ahead.
 */
import { join } from "node:path";
import { deskView, identityFromSeed, INTENTS_MAINNET, loadPoseidon, OneClick, type OneClickToken, PrivateWallet, quoteRequest, RelayerClient, tokenInfo, x402Fetch, type HushdNetwork } from "@hushd/sdk";
import { EncryptedFileStore } from "@hushd/sdk/node";
import { network, settings } from "./config.js";
import { app, listen } from "./http.js";
import { mids } from "./market.js";

export interface Ask {
  sellAmount: number;
  sell: string;
  buy: string;
}

/** "sell 2,500 USDC for NEAR", "swap 0.5 BTC to USDC", "2500 usdc -> wnear", "buy NEAR with 1000 USDC". */
export function parseAsk(text: string): Ask | null {
  const t = text.replace(/,(?=\d{3})/g, "");
  const sym = "([A-Za-z][A-Za-z0-9.]{1,11})";
  const num = "(\\d+(?:\\.\\d+)?)";
  const direct = new RegExp(`(?:sell|swap|trade|convert|price)?\\s*${num}\\s*${sym}\\s*(?:for|to|into|->|=>|in)\\s*${sym}`, "i").exec(t);
  if (direct) return { sellAmount: Number(direct[1]), sell: direct[2]!.toUpperCase(), buy: direct[3]!.toUpperCase() };
  const buy = new RegExp(`buy\\s+${sym}\\s+(?:with|for|using)\\s+${num}\\s*${sym}`, "i").exec(t);
  if (buy) return { sellAmount: Number(buy[2]), sell: buy[3]!.toUpperCase(), buy: buy[1]!.toUpperCase() };
  return null;
}

/** Hyperliquid names a coin by its plain symbol: wNEAR is NEAR, wrapped BTC is BTC. */
const hlCoin = (s: string) => ({ WNEAR: "NEAR", WBTC: "BTC", NBTC: "BTC", WETH: "ETH" })[s] ?? s;
const STABLE = new Set(["USDC", "USDT", "DAI"]);

export interface Priced {
  ask: Ask;
  oneClick: { out: number; outUsd: number | null; route: string } | null;
  mid: { sellUsd: number; buyUsd: number; fairOut: number } | null;
  makers: { name: string; out: number; paidTx: string }[];
  notes: string[];
}

/** The deliverable: plain Markdown a person or an agent can read. */
export function report(p: Priced): string {
  const { ask } = p;
  const fmt = (x: number) => (x >= 100 ? x.toLocaleString("en-US", { maximumFractionDigits: 2 }) : x.toPrecision(6).replace(/\.?0+$/, ""));
  const gap = (out: number) => (p.mid ? `${(((out - p.mid.fairOut) / p.mid.fairOut) * 10_000).toFixed(1)} bps` : "n/a");
  const rows = [
    ...(p.mid ? [`| Hyperliquid mid (fair value) | ${fmt(p.mid.fairOut)} ${ask.buy} | 0 bps |`] : []),
    ...(p.oneClick ? [`| NEAR Intents, 1Click (${p.oneClick.route}) | ${fmt(p.oneClick.out)} ${ask.buy} | ${gap(p.oneClick.out)} |`] : []),
    ...p.makers.map((m) => `| Hushd maker ${m.name} (testnet, indicative) | ${fmt(m.out)} ${ask.buy} | ${gap(m.out)} |`),
  ];
  return [
    `# Price check: ${fmt(ask.sellAmount)} ${ask.sell} for ${ask.buy}`,
    "",
    `At ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`,
    "",
    "| Source | You would receive | Against the mid |",
    "| --- | --- | --- |",
    ...rows,
    "",
    ...(p.oneClick?.outUsd ? [`1Click values the output at about $${fmt(p.oneClick.outUsd)}.`, ""] : []),
    ...(p.makers.length ? [`Each Hushd maker was paid 0.01 test USDC for its quote over private x402: the payment is a private note, so nobody sees who asked (${p.makers.map((m) => `[${m.name}](https://testnet.nearblocks.io/txns/${m.paidTx})`).join(", ")}).`, ""] : []),
    ...p.notes.map((n) => `- ${n}`),
    ...(p.notes.length ? [""] : []),
    "To trade it privately, with your limit sealed to an enclave and both legs settled in one call: https://hushd.net/app.",
  ].join("\n");
}

/** Hushd's private wallet for paying the makers' x402 quotes (testnet), when MARKET_AGENT_SEED is set. */
async function hushdWallet(net: HushdNetwork): Promise<PrivateWallet | null> {
  const seed = process.env.MARKET_AGENT_SEED;
  if (!seed) return null;
  await loadPoseidon();
  const bytes = Uint8Array.from(Buffer.from(seed, "hex"));
  const w = new PrivateWallet(net, identityFromSeed(bytes), {
    artifacts: { wasm: (n) => join(settings.circuitsDir(), `${n}.wasm`), zkey: (n) => join(settings.circuitsDir(), `${n}.zkey`) },
    relayer: new RelayerClient(settings.str("RELAYER_URL", net.api)),
    store: new EncryptedFileStore(join(settings.str("MAKERS_DATA_DIR", "./data/makers"), "..", "market-agent.notes.enc"), bytes),
  });
  await w.restore();
  return w;
}

export async function priceCheck(ask: Ask, deps: { net: HushdNetwork; oneClick: OneClick; tokens: () => Promise<OneClickToken[]>; wallet: PrivateWallet | null; makersBase: string }): Promise<Priced> {
  const notes: string[] = [];
  const out: Priced = { ask, oneClick: null, mid: null, makers: [], notes };
  const m = await mids().catch(() => ({}) as Record<string, number>);
  const usdOf = (s: string) => (STABLE.has(s) ? 1 : m[hlCoin(s)]);
  const [sellUsd, buyUsd] = [usdOf(ask.sell), usdOf(ask.buy)];
  if (sellUsd && buyUsd) out.mid = { sellUsd, buyUsd, fairOut: (ask.sellAmount * sellUsd) / buyUsd };
  else notes.push(`Hyperliquid has no mid for ${!sellUsd ? ask.sell : ask.buy}, so there is no fair value to compare against.`);

  // 1Click: prefer the token on NEAR, else the most common listing of that symbol
  const tokens = await deps.tokens();
  const pick = (s: string) => {
    const all = tokens.filter((t) => t.symbol.toUpperCase() === (s === "NEAR" ? "WNEAR" : s));
    return all.find((t) => t.blockchain === "near") ?? all[0];
  };
  const [from, to] = [pick(ask.sell), pick(ask.buy)];
  if (from && to) {
    const amount = BigInt(Math.floor(ask.sellAmount * 10 ** Math.min(from.decimals, 12))) * 10n ** BigInt(Math.max(0, from.decimals - 12));
    try {
      const q = await deps.oneClick.quote(quoteRequest({ originAsset: from.assetId, destinationAsset: to.assetId, amount: amount.toString(), recipient: "intents.near", refundTo: "intents.near", depositType: "INTENTS", refundType: "INTENTS", recipientType: "INTENTS" }));
      out.oneClick = { out: Number(q.quote.amountOutFormatted), outUsd: q.quote.amountOutUsd ? Number(q.quote.amountOutUsd) : null, route: `${from.blockchain} ${from.symbol} to ${to.blockchain} ${to.symbol}` };
    } catch (e) {
      notes.push(`1Click gave no quote: ${(e as Error).message.replace(/^1Click answered \d+: /, "")}`);
    }
  } else notes.push(`1Click does not list ${!from ? ask.sell : ask.buy}.`);

  // Hushd's makers price USDC, wNEAR and BTC on testnet; each quote costs 0.01 test USDC over private x402
  const testSym = (s: string) => (s === "NEAR" ? "wNEAR" : s === "WNEAR" ? "wNEAR" : s);
  let sellT: ReturnType<typeof tokenInfo> | null = null;
  let buyT: ReturnType<typeof tokenInfo> | null = null;
  try {
    sellT = tokenInfo(deps.net, testSym(ask.sell));
    buyT = tokenInfo(deps.net, testSym(ask.buy));
  } catch {
    notes.push("Hushd's makers quote USDC, wNEAR and BTC only, so they are not in this check.");
  }
  if (sellT && buyT && deps.wallet) {
    await deps.wallet.sync().catch(() => undefined);
    const amount = BigInt(Math.floor(ask.sellAmount * 10 ** Math.min(sellT.decimals, 12))) * 10n ** BigInt(Math.max(0, sellT.decimals - 12));
    const makers = (await deskView.makers(deps.net)).filter(([, x]) => x.active);
    for (const [, maker] of makers) {
      try {
        const { response, paid } = await x402Fetch(deps.wallet, `${deps.makersBase}/makers/${maker.name.toLowerCase()}/quote?sell=${sellT.id}&amount=${amount}&buy=${buyT.id}`, {}, { maxAmount: () => 20_000n });
        if (!response.ok) {
          notes.push(`${maker.name} had no quote for this size right now.`);
          continue;
        }
        const q = (await response.json()) as { give: { amount: string } };
        out.makers.push({ name: maker.name, out: Number(q.give.amount) / 10 ** buyT.decimals, paidTx: paid?.txHash ?? "" });
      } catch (e) {
        notes.push(`${maker.name} did not quote: ${(e as Error).message}`);
      }
    }
  } else if (sellT && buyT) notes.push("This worker has no Hushd balance set up, so it did not buy quotes from Hushd's makers.");
  return out;
}

interface Assignment {
  assignment: { assignmentId: string; status: string; startedAt: string | null };
  job: { jobId: string; title: string; description: string };
}

export async function startMarketAgent() {
  const token = settings.str("MARKET_AGENT_TOKEN", "");
  const base = settings.str("MARKET_URL", "https://market.near.ai").replace(/\/$/, "");
  const net = network();
  const oneClick = new OneClick(settings.str("ONECLICK_URL", INTENTS_MAINNET.oneClick), settings.str("ONECLICK_API_KEY", "") || undefined);
  let cache: { at: number; tokens: OneClickToken[] } = { at: 0, tokens: [] };
  const tokens = async () => {
    if (Date.now() - cache.at > 600_000) cache = { at: Date.now(), tokens: await oneClick.tokens() };
    return cache.tokens;
  };
  const wallet = await hushdWallet(net);
  const stats = { listed: !!token, delivered: 0, failed: 0, lastPollMs: 0 };
  listen(app("market", async () => ({ ...stats })), settings.port("market", 8794), "market");
  if (!token) {
    console.error("market: no MARKET_AGENT_TOKEN (the listing is not registered yet); idle");
    return;
  }
  const api = async <T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
    const r = await fetch(`${base}${path}`, { method: init?.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(init?.body ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${path} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  };
  const busy = new Set<string>();
  for (;;) {
    try {
      const { assignments } = await api<{ assignments: Assignment[] }>("/v1/agents/me/assignments");
      stats.lastPollMs = Date.now();
      for (const a of assignments) {
        const id = a.assignment.assignmentId;
        if (a.assignment.status !== "in_progress" || busy.has(id)) continue;
        busy.add(id);
        void (async () => {
          if (!a.assignment.startedAt) await api(`/v1/assignments/${id}/start`, { method: "POST", body: {} });
          const ask = parseAsk(`${a.job.title}\n${a.job.description}`);
          const md = ask
            ? report(await priceCheck(ask, { net, oneClick, tokens, wallet, makersBase: settings.str("MAKERS_PUBLIC_URL", "https://api.hushd.net") }))
            : "# Price check\n\nI could not find a pair and size in the request. Ask like this: \"sell 2,500 USDC for NEAR\" or \"buy BTC with 1,000 USDC\".";
          await api(`/v1/assignments/${id}/submit`, { method: "POST", body: { deliverableMarkdown: md } });
          stats.delivered++;
        })()
          .catch((e) => {
            stats.failed++;
            console.error(`market: assignment ${id}:`, (e as Error).message);
          })
          .finally(() => busy.delete(id));
      }
    } catch (e) {
      console.error("market:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, settings.num("MARKET_POLL_MS", 10_000)));
  }
}

/** For the listing script's dry run: one price check, printed. */
export async function tryPriceCheck(text: string): Promise<string> {
  const ask = parseAsk(text);
  if (!ask) return "no pair and size found";
  const net = network();
  const oneClick = new OneClick(settings.str("ONECLICK_URL", INTENTS_MAINNET.oneClick), settings.str("ONECLICK_API_KEY", "") || undefined);
  return report(await priceCheck(ask, { net, oneClick, tokens: () => oneClick.tokens(), wallet: await hushdWallet(net), makersBase: settings.str("MAKERS_PUBLIC_URL", "https://api.hushd.net") }));
}

