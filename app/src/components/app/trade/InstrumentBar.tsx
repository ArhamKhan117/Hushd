"use client";

import type { HourStats } from "@hushd/sdk";
import { Select } from "@/components/ui/Select";
import { fmtPct, fmtPrice, PAIRS, pairSource, type Pair } from "./pairs";
import type { Polled } from "./useMarket";

const dash = <span className="text-faint">-</span>;

/** The market across the top: which pair, its price now, and the last hour as numbers. */
export function InstrumentBar({ pair, onPair, mid, hour }: { pair: Pair; onPair: (id: string) => void; mid: number | null; hour: Polled<HourStats | null> }) {
  const h = hour.data;
  const arrow = h?.change ? (h.change > 0 ? "▲" : "▼") : null;
  return (
    <section className="tt-panel tt-bar hd-frame" aria-label="Market">
      <div className="tt-bar-main">
        <Select
          label="Market"
          value={pair.id}
          onChange={onPair}
          variant="pill"
          options={PAIRS.map((p) => ({ value: p.id, label: p.label, description: pairSource(p) }))}
        />
        <div className="min-w-0 max-sm:ml-auto max-sm:text-right">
          <p className="tt-price tnum" aria-live="off">
            {mid === null ? <span className="hd-skeleton inline-block h-7 w-32 align-middle" aria-label="Loading the price" /> : fmtPrice(mid)}
          </p>
          <p className="mt-1.5 truncate text-[12px] text-mute">
            {pair.quote.symbol} per {pair.base.symbol}
            <span className="max-sm:hidden"> · {pairSource(pair)}</span>
          </p>
        </div>
      </div>
      <dl className="tt-stats">
        <div>
          <dt>1h change</dt>
          <dd>
            {h?.change != null ? (
              <>
                <span aria-hidden className="mr-1 text-[10px] text-mute">
                  {arrow}
                </span>
                {fmtPct(h.change)}
              </>
            ) : (
              dash
            )}
          </dd>
        </div>
        <div>
          <dt>1h high</dt>
          <dd>{h ? fmtPrice(h.high, mid ?? h.last) : dash}</dd>
        </div>
        <div>
          <dt>1h low</dt>
          <dd>{h ? fmtPrice(h.low, mid ?? h.last) : dash}</dd>
        </div>
        <div title="Standard deviation of one-minute returns over the last hour, scaled to an hour: the measure the volatility maker widens its spread by">
          <dt>1h volatility</dt>
          <dd>{h?.volBps != null ? `${h.volBps.toFixed(0)} bps` : dash}</dd>
        </div>
      </dl>
    </section>
  );
}
