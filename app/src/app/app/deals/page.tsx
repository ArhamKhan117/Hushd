"use client";

import { deskView, type DealView } from "@hushd/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { NETWORK } from "@/lib/hushd/config";
import { CLASS_WORDS, dealState, KIND_WORDS, StateDot, when } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

export default function DealsPage() {
  const s = useHushd();
  const [deals, setDeals] = useState<DealView[] | null>(null);
  const [makers, setMakers] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      Promise.all([deskView.deals(NETWORK, 50), deskView.makers(NETWORK)])
        .then(([d, m]) => {
          if (!live) return;
          setDeals([...d].sort((a, b) => Number(b.id) - Number(a.id)));
          setMakers(new Map(m.map(([acc, x]) => [acc, x.name])));
        })
        .catch((e: Error) => live && setError(e.message));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

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
          {error && <p className="text-[13.5px] text-danger">Could not read the desk: {error}</p>}
          {!deals && !error && (
            <div className="grid gap-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="hd-skeleton h-14" />
              ))}
            </div>
          )}
          {deals && deals.length === 0 && <p className="text-[14px] text-mute">No deals yet. The first one starts at the Desk.</p>}
          {deals && deals.length > 0 && (
            <div className="hd-card overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[13.5px]">
                <thead>
                  <tr className="text-mute">
                    <th className="px-4 py-3 font-medium sm:px-5">Deal</th>
                    <th className="px-4 py-3 font-medium">Settlement</th>
                    <th className="px-4 py-3 font-medium">Maker</th>
                    <th className="px-4 py-3 font-medium">Matched</th>
                    <th className="px-4 py-3 font-medium sm:pr-5">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {deals.map((d) => {
                    const st = dealState(d);
                    return (
                      <tr key={d.id} className="hover:bg-surface/60">
                        <td className="px-4 py-3 sm:px-5">
                          <Link href={`/app/deals/${d.id}`} className="tnum text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                            #{d.id}
                          </Link>
                        </td>
                        <td className="px-4 py-3 text-soft">{CLASS_WORDS[d.class]}</td>
                        <td className="px-4 py-3 text-soft">{makers.get(d.maker) ?? d.maker}</td>
                        <td className="px-4 py-3 text-mute">{when(d.matched_at_ms)}</td>
                        <td className="px-4 py-3 sm:pr-5">
                          <span className="flex items-center gap-2 text-soft">
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
          )}
        </section>
      </div>
    </AppShell>
  );
}
