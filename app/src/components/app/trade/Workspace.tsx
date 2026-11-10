"use client";

/**
 * The bottom workspace: your requests, your deals with the terms only this wallet holds,
 * the hedge legs of your hedged deals, and their receipts. The terms come from the wallet's
 * encrypted store; where each deal stands comes from the desk contract.
 */
import { tokenInfo, type DealRecord, type DealView } from "@hushd/sdk";
import Link from "next/link";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Reveal } from "@/components/ui/Reveal";
import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";
import { dealState, KIND_WORDS, StateDot, when } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";
import { tabKeyTarget } from "@/lib/tabKeys";
import { fmtPrice, PAIRS, whole } from "./pairs";
import { runWord, type Run } from "./useDeskRun";

type Tab = "requests" | "deals" | "hedges" | "receipts";

const EVIDENCE_WORDS: Record<string, string> = {
  pool_settlement: "Pool settlement",
  pool_root: "Pool root",
  hyperliquid_fill: "Hyperliquid fill",
  hyperliquid_reject: "Hyperliquid did not fill",
  hedge_overdue: "Hedge overdue",
  bond_paid_privately: "Bond paid privately",
  bond_payout_returned: "Bond payout returned",
  intents_tx: "NEAR Intents settlement",
  expired: "Expired",
};

const OUTCOME_WORDS: Record<string, string> = { settled: "Settled", recovered: "Recovered", failed: "Failed", unresolved: "Unresolved" };

const amount = (x: { token: string; amount: string }) => (
  <>
    <span className="text-foreground">{fmt(x.token, BigInt(x.amount))}</span> {symbol(x.token)}
  </>
);

/** The price of a deal in its pair's terms: quote per base. */
function dealPrice(d: DealRecord): ReactNode {
  const p = PAIRS.find((x) => (x.base.id === d.gave.token && x.quote.id === d.got.token) || (x.base.id === d.got.token && x.quote.id === d.gave.token));
  if (!p) return "-";
  const [b, q] = p.base.id === d.gave.token ? [d.gave, d.got] : [d.got, d.gave];
  const price = whole(tokenInfo(NETWORK, q.token), q.amount) / whole(tokenInfo(NETWORK, b.token), b.amount);
  return (
    <>
      <span className="text-foreground">{fmtPrice(price)}</span>
      <span className="block text-[12px] text-mute">
        {p.quote.symbol} per {p.base.symbol}
      </span>
    </>
  );
}

/** Where a deal's hedge leg stands, from the desk's record. */
function hedgeWord(v: DealView | undefined): { word: string; tone: "ok" | "wait" | "bad" } {
  if (!v) return { word: "Reading the desk", tone: "wait" };
  if (v.receipt?.outcome === "recovered") return { word: "Missed: bond paid to you", tone: "ok" };
  if (v.receipt?.outcome === "failed") return { word: "Deal expired", tone: "bad" };
  if (v.status === "slashing") return { word: "Missed: paying the bond", tone: "wait" };
  if (v.status === "slash_refused") return { word: "Bond held for you", tone: "wait" };
  if (v.receipt?.outcome === "settled") return v.hedge_orders >= 2 ? { word: "Closed", tone: "ok" } : { word: "Open, filled", tone: "ok" };
  if (v.status === "hedge_pending") return v.hedge_orders === 1 ? { word: "Order out", tone: "wait" } : v.hedge_attempts > 0 ? { word: "Signing again", tone: "wait" } : { word: "Waiting to sign", tone: "wait" };
  return { word: "Spot settles first", tone: "wait" };
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-[13.5px] leading-relaxed text-mute">{children}</p>;
}

function State({ tone, children }: { tone: "ok" | "wait" | "bad"; children: ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-soft">
      <StateDot tone={tone} />
      {children}
    </span>
  );
}

export function Workspace({ runs, now, views }: { runs: Run[]; now: number; views: Map<number, DealView> | null }) {
  const s = useHushd();
  const [tab, setTab] = useState<Tab>("requests");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const deals = s.wallet?.deals() ?? [];
  const hedged = deals.filter((d) => d.kind !== "spot");
  const receipts = deals.filter((d) => views?.get(d.dealId)?.receipt);
  const sessionRfqs = new Set(runs.flatMap((r) => (r.rfqId !== undefined ? [r.rfqId] : [])));
  const older = deals.filter((d) => !sessionRfqs.has(d.rfqId));
  const venue = `Hyperliquid${IS_TESTNET ? " testnet" : ""}`;

  const tabs: { id: Tab; label: string; short?: string; count: number }[] = [
    { id: "requests", label: "Requests", count: runs.length + older.length },
    { id: "deals", label: "Deals", count: deals.length },
    { id: "hedges", label: "Hedge legs", short: "Hedges", count: hedged.length },
    { id: "receipts", label: "Receipts", count: receipts.length },
  ];
  const onKey = (e: KeyboardEvent, i: number) => {
    const to = tabKeyTarget(e.key, i, tabs.length);
    if (to === null) return;
    e.preventDefault();
    setTab(tabs[to]!.id);
    refs.current[to]?.focus();
  };

  const signedOut = s.status !== "ready";
  const view = (d: DealRecord) => views?.get(d.dealId);

  return (
    <section className="tt-panel tt-work hd-frame" aria-label="Your requests and deals">
      <div className="tt-tabs" role="tablist" aria-label="Your requests and deals">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`tt-tab-${t.id}`}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`tt-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.short ? (
              <>
                <span className="max-sm:hidden">{t.label}</span>
                <span className="sm:hidden">{t.short}</span>
              </>
            ) : (
              t.label
            )}
            {!signedOut && <span className="tt-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <Reveal>
        <div id={`tt-panel-${tab}`} role="tabpanel" aria-labelledby={`tt-tab-${tab}`} className="hd-settle-fast overflow-x-auto" key={tab} data-reveal-item>
          {signedOut ? (
            <Empty>Open your private balance to see your requests, deals, hedge legs and receipts. Only this browser can read their terms.</Empty>
          ) : tab === "requests" ? (
            runs.length + older.length === 0 ? (
              <Empty>No requests yet. Each one you send from the ticket shows here as it is sealed, quoted, matched and settled.</Empty>
            ) : (
              <table className="tt-table min-w-[720px]">
                <thead>
                  <tr>
                    <th scope="col">Request</th>
                    <th scope="col">Package</th>
                    <th scope="col">You sell</th>
                    <th scope="col">Least you accept</th>
                    <th scope="col" className="text-right">
                      Quotes
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => {
                    const w = runWord(r, now);
                    return (
                      <tr key={`run-${r.key}`}>
                        <td className="text-foreground">{r.rfqId !== undefined ? `#${r.rfqId}` : "Sealing"}</td>
                        <td>{KIND_WORDS[r.draft.kind]}</td>
                        <td>{amount({ token: r.draft.sell.token, amount: r.draft.sell.amount.toString() })}</td>
                        <td>
                          {r.draft.buy.minAmount > 0n ? amount({ token: r.draft.buy.token, amount: r.draft.buy.minAmount.toString() }) : <span className="text-mute">Best quote, {symbol(r.draft.buy.token)}</span>}
                          <span className="block text-[12px] text-mute">sealed to the enclave</span>
                        </td>
                        <td className="text-right">{r.quotes ?? "-"}</td>
                        <td className="whitespace-normal">
                          <State tone={w.tone}>
                            {w.word}
                            {r.dealId !== undefined && (
                              <Link href={`/app/deals/${r.dealId}`} className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                                deal #{r.dealId}
                              </Link>
                            )}
                          </State>
                          {r.failed && r.error && <span className="mt-0.5 block max-w-[38ch] text-[12px] leading-snug text-mute">{r.error}</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {older.map((d) => (
                    <tr key={`rfq-${d.rfqId}`}>
                      <td className="text-foreground">#{d.rfqId}</td>
                      <td>{KIND_WORDS[d.kind]}</td>
                      <td>{amount(d.gave)}</td>
                      <td className="text-mute">Sealed, not kept</td>
                      <td className="text-right">-</td>
                      <td>
                        <State tone="ok">
                          Matched
                          <Link href={`/app/deals/${d.dealId}`} className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                            deal #{d.dealId}
                          </Link>
                        </State>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : tab === "deals" ? (
            deals.length === 0 ? (
              <Empty>No deals yet. A request that matches becomes a deal; its terms are kept only in this wallet.</Empty>
            ) : (
              <table className="tt-table min-w-[820px]">
                <thead>
                  <tr>
                    <th scope="col">Deal</th>
                    <th scope="col">Package</th>
                    <th scope="col">You gave</th>
                    <th scope="col">You got</th>
                    <th scope="col">Price</th>
                    <th scope="col">Matched</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {deals.map((d) => {
                    const v = view(d);
                    const st = v ? dealState(v) : { word: d.settledAtMs ? "Settled" : "Reading the desk", tone: d.settledAtMs ? ("ok" as const) : ("wait" as const) };
                    return (
                      <tr key={d.dealId} data-deal={d.dealId}>
                        <td>
                          <Link href={`/app/deals/${d.dealId}`} className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                            #{d.dealId}
                          </Link>
                        </td>
                        <td>{KIND_WORDS[d.kind]}</td>
                        <td>{amount(d.gave)}</td>
                        <td>{amount(d.got)}</td>
                        <td>{dealPrice(d)}</td>
                        <td>{when(d.atMs)}</td>
                        <td>
                          <State tone={st.tone}>{st.word}</State>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : tab === "hedges" ? (
            hedged.length === 0 ? (
              <Empty>No hedge legs. On a Spot + hedge or Cash and carry deal (experimental), the maker places a bonded short on {venue} for its own account; if it misses, the bond is paid to you.</Empty>
            ) : (
              <table className="tt-table min-w-[820px]">
                <thead>
                  <tr>
                    <th scope="col">Deal</th>
                    <th scope="col">Leg</th>
                    <th scope="col">Limit</th>
                    <th scope="col">Fill by</th>
                    <th scope="col" className="text-right">
                      Orders
                    </th>
                    <th scope="col">Maker&apos;s bond</th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {hedged.map((d) => {
                    const v = view(d);
                    const h = v?.hedge;
                    const w = hedgeWord(v);
                    const open = v?.receipt?.outcome === "settled" && v.hedge_orders === 1 && Boolean(d.refundBlinding);
                    return (
                      <tr key={d.dealId}>
                        <td>
                          <Link href={`/app/deals/${d.dealId}`} className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                            #{d.dealId}
                          </Link>
                        </td>
                        <td>
                          {h ? (
                            <>
                              <span className="text-foreground">
                                {h.is_buy ? "Long" : "Short"} {h.size} {h.coin}
                              </span>
                              <span className="block text-[12px] text-mute">perp on Hyperliquid{h.testnet ? " testnet" : ""}, the maker&apos;s account</span>
                            </>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>{h ? `${h.limit_px} USD` : "-"}</td>
                        <td>{h ? when(h.deadline_ms) : "-"}</td>
                        <td className="text-right">{v ? `${v.hedge_attempts} of 3` : "-"}</td>
                        <td>{BigInt(d.bond) > 0n ? amount({ token: NETWORK.bondToken ?? NETWORK.tokens[0]!.id, amount: d.bond }) : "-"}</td>
                        <td>
                          <State tone={w.tone}>
                            {w.word}
                            {open && (
                              <Link href={`/app/deals/${d.dealId}`} className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                                Close it
                              </Link>
                            )}
                          </State>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          ) : receipts.length === 0 ? (
            <Empty>No receipts yet. The desk records one for each deal once it ends: settled, recovered with the bond, or failed.</Empty>
          ) : (
            <table className="tt-table min-w-[760px]">
              <thead>
                <tr>
                  <th scope="col">Deal</th>
                  <th scope="col">Outcome</th>
                  <th scope="col">Recorded</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">
                    <span className="sr-only">Prove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((d) => {
                  const r = view(d)!.receipt!;
                  return (
                    <tr key={d.dealId}>
                      <td>
                        <Link href={`/app/deals/${d.dealId}`} className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                          #{d.dealId}
                        </Link>
                      </td>
                      <td>
                        <State tone={r.outcome === "failed" ? "bad" : r.outcome === "unresolved" ? "wait" : "ok"}>{OUTCOME_WORDS[r.outcome] ?? r.outcome}</State>
                      </td>
                      <td>{when(r.recorded_at_ms)}</td>
                      <td className="whitespace-normal">{[...new Set(r.evidence.map((e) => EVIDENCE_WORDS[e.kind] ?? e.kind))].join(", ") || "-"}</td>
                      <td className="text-right">
                        {d.role === "trader" && r.outcome !== "failed" && (
                          <Link href={`/app/prove?deal=${d.dealId}`} className="hd-arrowlink text-[13px]">
                            Prove it <span aria-hidden>→</span>
                          </Link>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </Reveal>
    </section>
  );
}
