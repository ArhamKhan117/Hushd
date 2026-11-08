"use client";

import type { CandleInterval } from "@hushd/sdk";
import { fmtPrice, INTERVAL_WORDS, INTERVALS, ago, type Pair } from "./pairs";
import { PriceChart } from "./PriceChart";
import { useNow, type Polled, type Series } from "./useMarket";

export function ChartPanel({
  pair,
  interval,
  onInterval,
  mode,
  onMode,
  series,
  mid,
}: {
  pair: Pair;
  interval: CandleInterval;
  onInterval: (i: CandleInterval) => void;
  mode: "candles" | "line";
  onMode: (m: "candles" | "line") => void;
  series: Polled<{ series: Series; at: number }>;
  mid: number | null;
}) {
  const now = useNow(1_000);
  const data = series.data?.series ?? null;
  const cross = pair.quoteCoin !== null;
  const last = data ? (data.kind === "ohlc" ? data.candles.at(-1)?.c : data.points.at(-1)?.v) : undefined;
  const label = `${pair.label}, ${INTERVAL_WORDS[interval]} ${cross ? "cross rate" : "candles"} from Hyperliquid${last !== undefined ? `, last ${fmtPrice(last)} ${pair.quote.symbol}` : ""}`;
  return (
    <section className="tt-panel tt-chartpanel hd-frame" aria-label="Price chart">
      <div className="tt-head flex-wrap gap-y-2 py-2">
        <h2 className="hd-index" data-n="01">
          <i aria-hidden />
          Price
        </h2>
        <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
          <div className="tt-seg" role="group" aria-label="Candle size">
            {INTERVALS.map((i) => (
              <button key={i.value} type="button" aria-pressed={interval === i.value} aria-label={`${INTERVAL_WORDS[i.value]} candles`} onClick={() => onInterval(i.value)}>
                {i.label}
              </button>
            ))}
          </div>
          {!cross && (
            <div className="tt-seg" role="group" aria-label="Chart type">
              <button type="button" aria-pressed={mode === "candles"} aria-label="Candles" title="Candles" onClick={() => onMode("candles")}>
                <svg viewBox="0 0 16 16" className="mx-auto h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                  <path d="M5 2v2.5M5 11v3M11 2.5V5M11 12v1.5" strokeLinecap="round" />
                  <rect x="3.25" y="4.5" width="3.5" height="6.5" rx="0.6" />
                  <rect x="9.25" y="5" width="3.5" height="7" rx="0.6" fill="currentColor" />
                </svg>
              </button>
              <button type="button" aria-pressed={mode === "line"} aria-label="Line" title="Line" onClick={() => onMode("line")}>
                <svg viewBox="0 0 16 16" className="mx-auto h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                  <path d="M1.75 12 5.5 7.5l3 2.75 5.75-6.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
      {series.error && !data ? (
        <div className="grid flex-1 place-items-center p-6 text-center">
          <p className="max-w-[44ch] text-[13.5px] leading-relaxed text-mute">
            Prices are unavailable right now: {series.error}. The chart comes back by itself when the API answers.
          </p>
        </div>
      ) : (
        <PriceChart series={data} interval={interval} mode={cross ? "line" : mode} mid={mid} label={label} volumeUnit={cross ? null : pair.baseCoin} />
      )}
      <p className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[12px] text-mute">
        <span>{cross ? `${pair.baseCoin} close ÷ ${pair.quoteCoin} close, both Hyperliquid perps. Dashed: the mid now.` : `${pair.baseCoin} perp on Hyperliquid, in USD. Dashed: the mid now.`}</span>
        <span className="tnum">{series.data && now ? `Updated ${ago(series.data.at, Math.max(now, series.data.at))}` : "Loading"}</span>
      </p>
    </section>
  );
}
