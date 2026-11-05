"use client";

import Link from "next/link";
import { AppShell } from "@/components/app/AppShell";
import { SignInPanel } from "@/components/app/SignInPanel";
import { SealDots } from "@/components/ui/SealDots";
import { fmt, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

export default function BalancePage() {
  const s = useHushd();
  const pending = s.wallet?.pending() ?? [];
  return (
    <AppShell title="Private balance" subtitle="Notes only you can spend, in the pool on NEAR. Nobody can see how much you hold or what you move.">
      {s.status !== "ready" ? (
        <SignInPanel />
      ) : (
        <div className="grid gap-4">
          <div className="hd-panel p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="t-label">Your notes</p>
              <span className="text-[12.5px] text-mute">{s.syncing ? "Syncing with the pool…" : "In sync with the pool"}</span>
            </div>
            <ul className="mt-4 divide-y divide-line">
              {TOKENS.map((t) => {
                const v = s.balances.get(t.id) ?? 0n;
                return (
                  <li key={t.id} className="flex items-center justify-between py-3.5">
                    <span className="flex items-center gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-full bg-surface text-[12px] font-medium text-soft">{t.symbol.slice(0, 2)}</span>
                      <span>
                        <span className="block text-[15px] text-foreground">{t.symbol}</span>
                        <span className="block text-[12.5px] text-mute">{t.id}</span>
                      </span>
                    </span>
                    <span className="tnum text-right text-[17px] text-foreground">{v > 0n ? fmt(t.id, v) : <SealDots n={3} className="text-faint" />}</span>
                  </li>
                );
              })}
            </ul>
            {pending.length > 0 && <p className="mt-3 text-[13px] text-mute">{pending.length} note{pending.length > 1 ? "s" : ""} still landing in the pool.</p>}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["/app/balance/add", "Add privately"],
              ["/app/balance/send", "Send privately"],
              ["/app/balance/receive", "Receive"],
              ["/app/balance/cash-out", "Cash out"],
            ].map(([href, label]) => (
              <Link key={href} href={href!} className="btn btn-ghost">
                {label}
              </Link>
            ))}
          </div>
          <p className="text-[13px] leading-relaxed text-mute">
            Your receive address: <span className="break-all text-soft">{s.identity?.address}</span>
          </p>
        </div>
      )}
    </AppShell>
  );
}
