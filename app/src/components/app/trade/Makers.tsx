"use client";

/**
 * In place of an order book (a sealed auction has none): the makers taking requests and
 * what the chain shows of the desk. Bonds, deal counts and slashes come from `desk.makers`;
 * the latest deals from `desk.deals`, which hold no amounts and no trader.
 */
import { accountUrl } from "@hushd/sdk";
import Link from "next/link";
import { Reveal } from "@/components/ui/Reveal";
import { NETWORK } from "@/lib/hushd/config";
import { CLASS_WORDS, dealState, StateDot } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";
import { ago } from "./pairs";
import type { DeskPublic, Polled } from "./useMarket";

const BOND = NETWORK.bondToken ?? NETWORK.tokens[0]!.id;

const STYLE_WORDS: Record<string, string> = {
  fixed: "Fixed spread",
  volatility: "Prices volatility",
  inventory: "Prices its inventory",
};

const n = (v: unknown) => (typeof v === "number" || typeof v === "string" ? Number(v) : 0);

export function Makers({ desk, now }: { desk: Polled<DeskPublic>; now: number }) {
  const d = desk.data;
  const active = d?.makers.filter(([, m]) => m.active) ?? [];
  const names = new Map(d?.makers.map(([acc, m]) => [acc, m.name]) ?? []);
  const stats = d?.stats;
  return (
    <section className="tt-panel tt-makers hd-frame" aria-label="Makers on the desk">
      <div className="tt-head">
        <h2 className="hd-index" data-n="04">
          <i aria-hidden />
          Makers on the desk
        </h2>
        <Link href="/app/makers" className="hd-tap text-[12.5px] text-mute hover:text-foreground">
          All makers
        </Link>
      </div>
      {desk.error && !d && <p className="p-4 text-[13px] text-danger">Could not read the desk: {desk.error}</p>}
      {!d && !desk.error && (
        <div className="grid gap-2 p-4" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="hd-skeleton h-9" />
          ))}
        </div>
      )}
      {d && (
        <Reveal className="tt-makers-grid">
          <div className="min-w-0" data-reveal-item>
            <table className="tt-table">
              <caption className="sr-only">Makers taking requests, read from the desk contract</caption>
              <thead>
                <tr>
                  <th scope="col">Maker</th>
                  <th scope="col" className="text-right">
                    Bond
                  </th>
                  <th scope="col" className="text-right">
                    Deals
                  </th>
                  <th scope="col" className="text-right">
                    Slashed
                  </th>
                </tr>
              </thead>
              <tbody>
                {active.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-mute">
                      No maker is taking requests right now.
                    </td>
                  </tr>
                )}
                {active.map(([acc, m]) => (
                  <tr key={acc}>
                    <td>
                      <a href={accountUrl(NETWORK, acc)} target="_blank" rel="noreferrer" className="block text-foreground hover:underline hover:decoration-line-strong hover:underline-offset-4">
                        {m.name}
                      </a>
                      <span className="block text-[12px] text-mute">{STYLE_WORDS[m.style] ?? m.style}</span>
                    </td>
                    <td className="text-right">
                      <span className="text-foreground">{fmt(BOND, BigInt(m.bond), 0)}</span>
                      <span className="block text-[12px] text-mute">{BigInt(m.locked) > 0n ? `${fmt(BOND, BigInt(m.locked), 0)} locked` : symbol(BOND)}</span>
                    </td>
                    <td className="text-right text-foreground">{m.deals}</td>
                    <td className="text-right">{BigInt(m.slashed) > 0n ? fmt(BOND, BigInt(m.slashed), 0) : "0"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="tt-makers-side" data-reveal-item>
            <dl className="grid grid-cols-3 gap-px border-b border-line bg-line text-[12px]">
              {[
                ["Requests", n(stats?.rfqs)],
                ["Deals", n(stats?.deals)],
                ["Settled", n(stats?.settled)],
              ].map(([k, v]) => (
                <div key={k} className="bg-panel px-4 py-2.5">
                  <dt className="text-mute">{k}</dt>
                  <dd className="tnum mt-0.5 text-[14px] text-foreground">{Number(v).toLocaleString("en-US")}</dd>
                </div>
              ))}
            </dl>
            <p className="px-4 pb-1 pt-3 text-[12px] text-mute">Latest deals: public record, no amounts, no trader</p>
            <ul className="pb-2">
              {d.recent.slice(0, 8).map((x, i) => {
                const st = dealState(x);
                return (
                  <li key={x.id} className={i >= 5 ? "tt-deal-extra" : undefined}>
                    <Link href={`/app/deals/${x.id}`} className="flex items-center justify-between gap-3 px-4 py-1.5 text-[13px] hover:bg-surface/60">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="tnum text-foreground">#{x.id}</span>
                        <span className="truncate text-mute">
                          {CLASS_WORDS[x.class]} · {names.get(x.maker) ?? x.maker}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-soft">
                        <StateDot tone={st.tone} />
                        <span className="tnum text-[12px] text-mute">{ago(Number(x.matched_at_ms), now)}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
              {d.recent.length === 0 && <li className="px-4 py-2 text-[13px] text-mute">No deals yet.</li>}
            </ul>
          </div>
        </Reveal>
      )}
    </section>
  );
}
