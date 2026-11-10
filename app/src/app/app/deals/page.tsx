"use client";

import { deskView, view, type DealView } from "@hushd/sdk";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { BusyLabel } from "@/components/ui/Spinner";
import { NETWORK } from "@/lib/hushd/config";
import { CLASS_WORDS, dealState, KIND_WORDS, StateDot, when } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

/** Deals per page: the newest page refreshes, older pages load on request. */
const PAGE = 25;

/** Deals before `before` (exclusive), newest first, read from the desk. */
const dealsBefore = (before: number) => view<DealView[]>(NETWORK, NETWORK.desk!, "deals", { from_index: String(before), limit: PAGE });

/** Newest first, one entry per deal id. */
function merge(into: DealView[], more: DealView[]): DealView[] {
  const all = new Map(into.map((d) => [d.id, d]));
  for (const d of more) all.set(d.id, d);
  return [...all.values()].sort((a, b) => Number(b.id) - Number(a.id));
}

export default function DealsPage() {
  const s = useHushd();
  const [deals, setDeals] = useState<DealView[] | null>(null);
  const [makers, setMakers] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([deskView.deals(NETWORK, PAGE), deskView.makers(NETWORK)])
        .then(([d, m]) => {
          if (!live) return;
          // the newest page refreshes in place; older pages already shown stay
          setDeals((prev) => merge(prev ?? [], d));
          setMakers(new Map(m.map(([acc, x]) => [acc, x.name])));
          setError(null);
        })
        .catch((e: Error) => live && setError(e.message));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // deal ids count up from 0, so the oldest one shown says whether any are left
  const oldest = deals && deals.length > 0 ? Number(deals.at(-1)!.id) : null;
  const showOlder = useCallback(() => {
    if (oldest === null || oldest === 0) return;
    setLoadingOlder(true);
    setOlderError(null);
    dealsBefore(oldest)
      .then((d) => setDeals((prev) => merge(prev ?? [], d)))
      .catch((e: Error) => setOlderError(e.message))
      .finally(() => setLoadingOlder(false));
  }, [oldest]);

  const mine = s.wallet?.deals() ?? [];
  const byId = new Map((deals ?? []).map((d) => [Number(d.id), d]));

  return (
    <AppShell title="Deals" subtitle="Every deal the desk has matched. The chain shows that a deal happened and how it ended; the amounts and the trader stay private.">
      <div className="grid gap-6">
        {mine.length > 0 && (
          <section className="grid gap-3">
            <p className="t-label">Yours (only this browser can read these)</p>
            <ul className="hd-card divide-y divide-line">
              {mine.map((d) => {
                const v = byId.get(d.dealId);
                const st = v ? dealState(v) : null;
                return (
                  <li key={d.dealId}>
                    <Link href={`/app/deals/${d.dealId}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3.5 hover:bg-surface/60 sm:px-5">
                      <span className="min-w-0">
                        <span className="block text-[14.5px] text-foreground">
                          #{d.dealId} · {fmt(d.gave.token, BigInt(d.gave.amount))} {symbol(d.gave.token)} → {fmt(d.got.token, BigInt(d.got.amount))} {symbol(d.got.token)}
                        </span>
                        <span className="block text-[12.5px] text-mute">
                          {KIND_WORDS[d.kind]} with {makers.get(d.maker) ?? d.maker} · {when(d.atMs)}
                        </span>
                      </span>
                      {st && (
                        <span className="flex items-center gap-2 text-[13px] text-soft">
                          <StateDot tone={st.tone} />
                          {st.word}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="grid gap-3">
          <p className="t-label">On the desk</p>
          {error && !deals && <p className="text-[13.5px] text-danger">Could not read the desk: {error}</p>}
          {!deals && !error && (
            <div className="grid gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="hd-skeleton h-14" />
              ))}
            </div>
          )}
          {deals && deals.length === 0 && <p className="text-[14px] text-mute">No deals yet. The first one starts at the Desk.</p>}
          {deals && deals.length > 0 && (
            <>
              <div className="hd-card overflow-x-auto">
                {/* on a phone the table keeps the deal, its maker and its state; the class and the time go under the deal */}
                <table className="w-full text-left text-[13.5px] sm:min-w-[620px]">
                  <thead>
                    <tr className="text-mute">
                      <th scope="col" className="px-4 py-3 font-medium sm:px-5">
                        Deal
                      </th>
                      <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                        Settlement
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        Maker
                      </th>
                      <th scope="col" className="hidden px-4 py-3 font-medium sm:table-cell">
                        Matched
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium sm:pr-5">
                        State
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {deals.map((d) => {
                      const st = dealState(d);
                      return (
                        <tr key={d.id} className="align-top hover:bg-surface/60 sm:align-middle">
                          <td className="px-4 py-3 sm:px-5">
                            <Link href={`/app/deals/${d.id}`} className="tnum text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                              #{d.id}
                            </Link>
                            <span className="mt-0.5 block whitespace-nowrap text-[12px] text-mute sm:hidden">{when(d.matched_at_ms)}</span>
                          </td>
                          <td className="hidden px-4 py-3 text-soft sm:table-cell">{CLASS_WORDS[d.class]}</td>
                          <td className="px-4 py-3 text-soft">
                            <span className="[overflow-wrap:anywhere]">{makers.get(d.maker) ?? d.maker}</span>
                            <span className="mt-0.5 block text-[12px] text-mute sm:hidden">{CLASS_WORDS[d.class]}</span>
                          </td>
                          <td className="hidden whitespace-nowrap px-4 py-3 text-mute sm:table-cell">{when(d.matched_at_ms)}</td>
                          <td className="px-4 py-3 sm:pr-5">
                            <span className="flex items-center gap-2 whitespace-nowrap text-soft">
                              <StateDot tone={st.tone} />
                              {st.word}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="tnum text-[12.5px] text-mute">
                  {oldest === 0 ? `All ${deals.length} deals, newest first.` : `The ${deals.length} newest deals, down to #${oldest}.`}
                </p>
                {oldest !== null && oldest > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={showOlder} disabled={loadingOlder} aria-busy={loadingOlder}>
                    <BusyLabel busy={loadingOlder} busyText="Reading the desk…">
                      Show older deals
                    </BusyLabel>
                  </button>
                )}
              </div>
              {olderError && <p className="text-[13.5px] text-danger">Could not read older deals: {olderError}</p>}
            </>
          )}
        </section>
      </div>
    </AppShell>
  );
}
