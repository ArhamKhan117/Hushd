"use client";

import { formatUnits, parseUnits } from "@hushd/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { Segmented } from "@/components/app/desk";
import { AmountCard, Field } from "@/components/app/forms";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { IS_TESTNET } from "@/lib/hushd/config";
import { fmt, symbol, TOKENS } from "@/lib/hushd/format";
import { amount as readable, ApiError, duration, intentsQuote, intentsTokens, percent, usd, type Direction, type IntentsChain, type IntentsQuote, type IntentsToken, type IntentsTokens } from "@/lib/hushd/intents";

/**
 * A deposit from another chain, or a cash out to one, through NEAR Intents 1Click, shown
 * as a live dry quote from mainnet. Nothing here makes a deposit address or sends anything:
 * on testnet Hushd's pool holds test tokens, and on mainnet the route is not live yet.
 */

const DEFAULT_CHAIN = "base";

/** The Hushd token an asset on another chain is the same thing as, if any. */
function sameAs(sym: string): string | null {
  const s = sym.toUpperCase();
  if (/^USDCX?$/.test(s)) return "USDC";
  if (/^(W|CB)?BTC$/.test(s)) return "BTC";
  if (/^W?NEAR$/.test(s)) return "wNEAR";
  return null;
}

function parse(input: string, decimals: number): bigint | null {
  try {
    const v = parseUnits(input.replace(/,/g, ""), decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

function assetOptions(chain: IntentsChain): SelectOption[] {
  const count = new Map<string, number>();
  for (const t of chain.tokens) count.set(t.symbol, (count.get(t.symbol) ?? 0) + 1);
  return chain.tokens.map((t) => {
    // two assets with one symbol (a chain's native and bridged USDC) are told apart by their id
    const id = t.assetId.replace(/^[a-z0-9]+:/, "");
    const tail = id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-6)}` : id;
    return { value: t.assetId, label: t.symbol, description: (count.get(t.symbol) ?? 0) > 1 ? tail : (usd(t.price) ?? "No price") };
  });
}

function chainOptions(list: IntentsTokens): SelectOption[] {
  return list.chains.map((c) => {
    const shown = c.tokens.slice(0, 3).map((t) => t.symbol);
    const more = c.tokens.length - shown.length;
    return { value: c.id, label: c.name, description: `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` };
  });
}

function LockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="2.2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Route({ parts }: { parts: string[] }) {
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] leading-snug text-foreground">
      {parts.map((p, i) => (
        <span key={p} className="inline-flex items-center gap-2">
          {i > 0 && (
            <>
              <span aria-hidden className="text-faint">
                →
              </span>
              <span className="sr-only">then</span>
            </>
          )}
          {p}
        </span>
      ))}
    </p>
  );
}

function Row({ label, value, sub, strong }: { label: string; value: ReactNode; sub?: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="shrink-0 text-[13.5px] text-mute">{label}</dt>
      <dd className="min-w-0 text-right">
        <span className={`tnum block [overflow-wrap:anywhere] text-foreground ${strong ? "text-[17px]" : "text-[14.5px]"}`}>{value}</span>
        {sub && <span className="mt-0.5 block text-[12px] text-mute">{sub}</span>}
      </dd>
    </div>
  );
}

function QuoteRows({ q }: { q: IntentsQuote }) {
  const { from, to, quote } = q;
  const inHushd = "in your Hushd balance";
  const where = (side: typeof from) => (side.chain === "near" ? (side === from ? "from your Hushd balance" : inHushd) : `on ${side.chainName}`);
  const withUsd = (words: string, v?: string) => {
    const u = usd(v);
    return u ? `${words} · ≈ ${u}` : words;
  };
  const feeBps = (q.quoteRequest.appFees ?? []).reduce((n, f) => n + f.fee, 0);
  const withdrawFee = quote.withdrawFee && /^\d+$/.test(quote.withdrawFee) ? BigInt(quote.withdrawFee) : 0n;
  const time = duration(quote.timeEstimate);
  return (
    <dl className="mt-4 divide-y divide-line border-y border-line">
      <Row label="You send" value={`${readable(quote.amountInFormatted)} ${from.symbol}`} sub={withUsd(where(from), quote.amountInUsd)} />
      <Row label="You receive" value={`${readable(quote.amountOutFormatted)} ${to.symbol}`} sub={withUsd(where(to), quote.amountOutUsd)} strong />
      <Row label="At least" value={`${readable(formatUnits(BigInt(quote.minAmountOut), to.decimals))} ${to.symbol}`} sub={`If the price moves up to ${percent(q.quoteRequest.slippageTolerance)}`} />
      <Row label="1Click fee" value={feeBps > 0 ? percent(feeBps) : "None"} sub={feeBps > 0 ? "Included above" : undefined} />
      {withdrawFee > 0n && <Row label={`Fee to deliver on ${to.chainName}`} value={`${readable(formatUnits(withdrawFee, to.decimals))} ${to.symbol}`} sub="Included above" />}
      {time && <Row label="Time" value={time} />}
    </dl>
  );
}

type Result = { key: string; route: string; quote?: IntentsQuote; error?: string; retry?: boolean; at: number };

function QuoteCard({ route, hint, loading, result, sameRoute, onAgain }: { route: string[]; hint: string | null; loading: boolean; result: Result | null; sameRoute: boolean; onAgain: () => void }) {
  const shown = hint ? null : loading ? (sameRoute && result?.quote ? result : null) : result;
  return (
    <section className="hd-card p-5 sm:p-6" aria-label="Live quote" aria-busy={loading}>
      <div className="flex min-h-6 flex-wrap items-center justify-between gap-2">
        <p className="t-label">Live quote</p>
        {loading && !hint ? (
          <span className="inline-flex items-center gap-2 text-[12.5px] text-mute">
            <Spinner /> Asking 1Click…
          </span>
        ) : shown?.quote ? (
          shown.quote.confidential ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sealed-soft px-2.5 py-1 text-[12px] font-medium text-sealed">
              <LockIcon /> Confidential
            </span>
          ) : (
            <span className="rounded-full bg-surface px-2.5 py-1 text-[12px] text-soft">Public quote</span>
          )
        ) : null}
      </div>
      <Route parts={route} />
      <div aria-live="polite">
        {hint ? (
          <p className="mt-4 text-[13.5px] leading-relaxed text-mute">{hint}</p>
        ) : shown?.quote ? (
          <div className={`transition-opacity duration-200 ${loading ? "opacity-50" : "hd-settle-fast"}`}>
            <QuoteRows q={shown.quote} />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[12.5px] leading-relaxed text-mute">
                Quoted {new Date(shown.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} by 1Click on mainnet.
              </p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onAgain} disabled={loading}>
                Quote again
              </button>
            </div>
          </div>
        ) : shown?.error ? (
          <div className="mt-4 flex flex-col items-start gap-3">
            <p role="alert" className="text-[13.5px] leading-relaxed text-danger">
              {shown.error}
            </p>
            {shown.retry && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onAgain}>
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="mt-4 grid gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="hd-skeleton h-11" />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Loading() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading what 1Click can route">
      <div className="hd-skeleton h-[74px] rounded-[14px]" />
      <div className="hd-skeleton h-[118px] rounded-[20px]" />
      <div className="hd-skeleton h-[74px] rounded-[14px]" />
    </div>
  );
}

export function OtherChainPreview({ direction, balances }: { direction: Direction; balances?: Map<string, bigint> }) {
  const deposit = direction === "deposit";
  const [list, setList] = useState<IntentsTokens | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listTry, setListTry] = useState(0);
  useEffect(() => {
    let live = true;
    intentsTokens().then(
      (l) => live && setList(l),
      (e: Error) => live && setListError(e.message),
    );
    return () => {
      live = false;
    };
  }, [listTry]);

  const [chainId, setChainId] = useState(DEFAULT_CHAIN);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [tokenId, setTokenId] = useState(TOKENS[0]!.id);
  const [input, setInput] = useState("");
  const [address, setAddress] = useState("");
  const [nonce, setNonce] = useState(0);
  const [result, setResult] = useState<Result | null>(null);

  const offered = TOKENS.filter((t) => !list || list.hushd.some((h) => h.symbol === t.symbol));
  const hushd: IntentsToken | null = list?.hushd.find((h) => h.symbol === symbol(tokenId)) ?? null;
  const chain = list?.chains.find((c) => c.id === chainId) ?? list?.chains[0] ?? null;
  // until one is picked: on a deposit the chain's first asset, on a cash out the same asset as the Hushd token if the chain has it
  const fallback = (c: IntentsChain) => (!deposit && c.tokens.find((t) => sameAs(t.symbol) === symbol(tokenId))) || c.tokens[0]!;
  const asset = chain ? (chain.tokens.find((t) => t.assetId === assetId) ?? fallback(chain)) : null;
  const sent = deposit ? asset : hushd;
  const base = sent ? parse(input, sent.decimals) : null;
  const you = address.trim();

  const req = asset && hushd && base !== null && you ? JSON.stringify({ direction, asset: asset.assetId, token: hushd.symbol, amount: base.toString(), address: you }) : null;
  const route = asset && hushd ? `${direction}|${asset.assetId}|${hushd.symbol}` : "";
  const key = req ? `${req}#${nonce}` : null;

  useEffect(() => {
    if (!req || !key) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      intentsQuote(JSON.parse(req), ctl.signal).then(
        (quote) => setResult({ key, route, quote, at: Date.now() }),
        (e: Error) => {
          // a request 1Click refused stays refused; anything else may work a moment later
          if (!ctl.signal.aborted) setResult({ key, route, error: e.message, retry: !(e instanceof ApiError && e.status === 400), at: Date.now() });
        },
      );
    }, 450);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [req, key, route]);

  if (!list || !chain || !asset || !hushd) {
    if (!listError) return <Loading />;
    return (
      <div className="flex flex-col items-start gap-3 rounded-[14px] bg-surface px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div>
          <p className="text-[15px] text-foreground">The chains are not available right now</p>
          <p className="mt-1 max-w-[56ch] text-[13.5px] leading-relaxed text-mute">{listError}</p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm shrink-0"
          onClick={() => {
            setListError(null);
            setListTry((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  // on a deposit, an asset Hushd also holds lands as itself (Bitcoin BTC into BTC)
  const pickAsset = (t: IntentsToken) => {
    setAssetId(t.assetId);
    const same = deposit ? offered.find((x) => x.symbol === sameAs(t.symbol)) : undefined;
    if (same) setTokenId(same.id);
  };
  const onChain = (id: string) => {
    const next = list.chains.find((c) => c.id === id);
    if (!next) return;
    setChainId(id);
    // keep the same asset where the new chain has it
    pickAsset(next.tokens.find((t) => t.symbol === asset.symbol) ?? fallback(next));
  };
  const onAsset = (id: string) => {
    const t = chain.tokens.find((x) => x.assetId === id);
    if (t) pickAsset(t);
  };
  const onToken = (id: string) => {
    setTokenId(id);
    const same = !deposit ? chain.tokens.find((t) => sameAs(t.symbol) === symbol(id)) : undefined;
    if (same) setAssetId(same.assetId);
  };

  const worth = base !== null && sent?.price != null ? usd((Number(formatUnits(base, sent.decimals)) * sent.price).toFixed(6)) : null;
  const missing = [base === null ? "an amount" : null, you ? null : `your ${chain.name} address`].filter(Boolean);
  const hint = missing.length ? `Enter ${missing.join(" and ")} to see what would ${deposit ? "reach your Hushd balance" : `arrive on ${chain.name}`}.` : null;
  const current = result && result.key === key ? result : null;
  const loading = Boolean(key) && !current;
  const elsewhere = `${asset.symbol} on ${chain.name}`;
  const routeWords = deposit ? [elsewhere, "NEAR Intents", `${hushd.symbol} in your Hushd balance`] : [`${hushd.symbol} in your Hushd balance`, "NEAR Intents", elsewhere];
  const lastQuote = current?.quote ?? result?.quote ?? null;

  const addressField = (
    <Field
      label={deposit ? `Your ${chain.name} address, for refunds` : `Your ${chain.name} address`}
      hint={deposit ? "If the swap cannot be filled, 1Click sends the tokens back here. Used only for this quote." : `Where 1Click would pay out the ${asset.symbol}. Used only for this quote.`}
    >
      <input
        className="hd-input w-full"
        aria-label={deposit ? `Your ${chain.name} address, for refunds` : `Your ${chain.name} address`}
        placeholder={`${chain.name} address`}
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
      />
    </Field>
  );

  return (
    <div className="grid gap-4">
      {deposit ? (
        <>
          <Field label="From chain" hint={`1Click routes from ${list.chains.length} chains besides NEAR.`}>
            <Select label="From chain" value={chain.id} onChange={onChain} options={chainOptions(list)} className="w-full" />
          </Field>
          <AmountCard
            label="You send"
            value={input}
            onChange={setInput}
            picker={<Select variant="pill" align="end" label="Asset" value={asset.assetId} onChange={onAsset} options={assetOptions(chain)} />}
            note={`${elsewhere}${worth ? ` · ≈ ${worth}` : ""}`}
          />
          <Field label="Into your private balance as">
            <Segmented label="Into your private balance as" value={tokenId} onChange={setTokenId} options={offered.map((t) => ({ value: t.id, label: t.symbol }))} />
          </Field>
          {addressField}
        </>
      ) : (
        <>
          <AmountCard
            label="Amount"
            value={input}
            onChange={setInput}
            token={tokenId}
            onToken={onToken}
            balances={balances}
            note={[balances ? `Private balance: ${fmt(tokenId, balances.get(tokenId) ?? 0n)} ${symbol(tokenId)}` : null, worth ? `≈ ${worth} at mainnet prices` : null].filter(Boolean).join(" · ") || `${symbol(tokenId)} from your private balance`}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="To chain">
              <Select label="To chain" value={chain.id} onChange={onChain} options={chainOptions(list)} className="w-full" />
            </Field>
            <Field label="Receive as">
              <Select label="Receive as" value={asset.assetId} onChange={setAssetId} options={assetOptions(chain)} className="w-full" />
            </Field>
          </div>
          {addressField}
        </>
      )}

      <QuoteCard route={routeWords} hint={hint} loading={loading} result={result} sameRoute={result?.route === route} onAgain={() => setNonce((n) => n + 1)} />

      <div className="grid gap-2 text-[12.5px] leading-relaxed text-mute">
        <p>
          {IS_TESTNET
            ? "Hushd's pool runs on NEAR testnet with test tokens, so this stays a preview: no deposit address is made and nothing is sent."
            : "This is a preview for now: no deposit address is made and nothing is sent."}{" "}
          {deposit
            ? `${IS_TESTNET ? "On mainnet" : "Once it is live"}, 1Click would give you a deposit address on ${chain.name} and pay the ${hushd.symbol} to your NEAR account, ready to add privately.`
            : `${IS_TESTNET ? "On mainnet" : "Once it is live"}, the cash out would pay 1Click's deposit address on NEAR, and 1Click would send the ${asset.symbol} to your ${chain.name} address.`}
        </p>
        <p>
          {deposit ? "The NEAR account" : "The NEAR refund account"} in this preview is the all-zero implicit account, which no one holds a key for.
          {lastQuote &&
            (lastQuote.confidential
              ? " This quote is confidential: on NEAR Intents, its deposit and its payout cannot be linked."
              : " This quote is public: a confidential one needs a 1Click partner key on the Hushd API.")}
        </p>
      </div>
    </div>
  );
}
