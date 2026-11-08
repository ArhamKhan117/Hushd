"use client";

/**
 * The price chart: Hyperliquid candles (or a cross rate as a line), drawn as SVG so it
 * takes the theme's tokens directly and stays sharp at any size. A crosshair reads any
 * candle; the dashed line is the live mid. Nothing is drawn that the API did not send.
 */
import { INTERVAL_MS, type CandleInterval, type PricePoint } from "@hushd/sdk";
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { fmtPct, fmtPrice, fmtVolume } from "./pairs";
import type { Series } from "./useMarket";

const AXIS_R = 64;
const AXIS_B = 24;
const LEFT = 0;
/** Room above the plot for the legend: one line on a wide chart, two on a narrow one. */
const topFor = (w: number) => (w < 560 ? 60 : 44);

interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

function bars(s: Series): Bar[] {
  return s.kind === "ohlc" ? s.candles.map((c) => ({ ...c })) : s.points.map((p: PricePoint) => ({ t: p.t, o: p.v, h: p.v, l: p.v, c: p.v, v: null }));
}

/** About `count` round numbers across [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count);
  if (!(raw > 0)) return [lo];
  const mag = 10 ** Math.floor(Math.log10(raw));
  // the round step nearest the raw one, so a range gets about `count` lines, not half as many
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).reduce((best, s) => (Math.abs(Math.log(s / raw)) < Math.abs(Math.log(best / raw)) ? s : best));
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

const TIME_STEPS = [5, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080, 20160, 43200].map((m) => m * 60_000);
const tz = () => new Date().getTimezoneOffset() * 60_000;
const hm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dm = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const local = (t: number) => t - tz();

/** Candle indexes at round local times, at most one per `minGap` px. */
function timeTicks(list: Bar[], slot: number, interval: CandleInterval, minGap = 84): { i: number; label: string }[] {
  if (list.length < 2) return [];
  const span = INTERVAL_MS[interval];
  const step = TIME_STEPS.find((s) => s >= span && (s / span) * slot >= minGap) ?? TIME_STEPS.at(-1)!;
  return list.flatMap((b, i) => {
    if (local(b.t) % step !== 0) return [];
    const midnight = local(b.t) % 86_400_000 === 0;
    return [{ i, label: step >= 86_400_000 || midnight ? dm(b.t) : hm(b.t) }];
  });
}

function stamp(t: number, interval: CandleInterval): string {
  return INTERVAL_MS[interval] >= 86_400_000 ? new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : `${dm(t)} ${hm(t)}`;
}

export function PriceChart({
  series,
  interval,
  mode,
  mid,
  label,
  volumeUnit,
}: {
  series: Series | null;
  interval: CandleInterval;
  mode: "candles" | "line";
  mid: number | null;
  /** Read by screen readers in place of the drawing. */
  label: string;
  /** The coin the volume is counted in, or null to draw no volume. */
  volumeUnit: string | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<{ i: number; y: number } | null>(null);
  const gid = useId().replace(/:/g, "");

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // as many of the latest candles as fit at a readable width (at least 6 px each)
  const fit = Math.max(30, Math.floor((size.w - AXIS_R - LEFT) / 6));
  const list = useMemo(() => (series ? bars(series).slice(-fit) : []), [series, fit]);
  const ohlc = series?.kind === "ohlc" && mode === "candles";
  const withVolume = series?.kind === "ohlc" && volumeUnit !== null;
  const ref = mid ?? list.at(-1)?.c ?? 0;

  const geo = useMemo(() => {
    const { w, h } = size;
    if (!w || !h || list.length === 0) return null;
    const right = w - AXIS_R;
    const bottom = h - AXIS_B;
    const TOP = topFor(w);
    const volH = withVolume ? Math.round((bottom - TOP) * 0.16) : 0;
    const priceBottom = bottom - (volH ? volH + 8 : 0);
    const highs = list.map((b) => (ohlc ? b.h : b.c));
    const lows = list.map((b) => (ohlc ? b.l : b.c));
    let lo = Math.min(...lows, ...(mid ? [mid] : []));
    let hi = Math.max(...highs, ...(mid ? [mid] : []));
    const pad = (hi - lo) * 0.08 || hi * 0.002;
    lo -= pad;
    hi += pad;
    const y = (v: number) => TOP + ((hi - v) / (hi - lo)) * (priceBottom - TOP);
    const slot = (right - LEFT) / list.length;
    const x = (i: number) => LEFT + (i + 0.5) * slot;
    const vMax = withVolume ? Math.max(...list.map((b) => b.v ?? 0), 1e-12) : 1;
    const vy = (v: number) => bottom - (v / vMax) * volH;
    return { w, h, TOP, right, bottom, priceBottom, volH, lo, hi, y, x, slot, vy, ticks: niceTicks(lo, hi, Math.max(3, Math.round((priceBottom - TOP) / 56))), times: timeTicks(list, slot, interval) };
  }, [size, list, ohlc, withVolume, mid, interval]);

  // the drawing that only changes with the data or the size: memoised apart from the crosshair
  const layer = useMemo(() => {
    if (!geo) return null;
    const { x, y, slot, bottom, right, priceBottom, vy, TOP } = geo;
    const bodyW = Math.max(1, Math.min(14, Math.floor(slot * 0.62)));
    const line = list.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.c).toFixed(1)}`).join("");
    return (
      <>
        <g className="tt-grid" aria-hidden>
          {geo.ticks.map((v) => (
            <line key={v} x1={LEFT} x2={right} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
          ))}
          {geo.times.map((t) => (
            <line key={t.i} x1={Math.round(x(t.i)) + 0.5} x2={Math.round(x(t.i)) + 0.5} y1={TOP - 4} y2={bottom} />
          ))}
        </g>
        {withVolume && (
          <g className="tt-vol" aria-hidden>
            {list.map((b, i) => (
              <rect key={b.t} x={Math.round(x(i) - bodyW / 2)} y={vy(b.v ?? 0)} width={bodyW} height={Math.max(0.5, bottom - vy(b.v ?? 0))} />
            ))}
          </g>
        )}
        {ohlc ? (
          <g aria-hidden>
            {list.map((b, i) => {
              const up = b.c >= b.o;
              const cx = Math.round(x(i)) + 0.5;
              const top = y(Math.max(b.o, b.c));
              const body = Math.max(1, y(Math.min(b.o, b.c)) - top);
              return (
                <g key={b.t} className={up ? "tt-up" : "tt-down"}>
                  <line x1={cx} x2={cx} y1={y(b.h)} y2={y(b.l)} />
                  {bodyW > 2 && <rect x={Math.round(x(i) - bodyW / 2)} y={top} width={bodyW} height={body} />}
                </g>
              );
            })}
          </g>
        ) : (
          <g aria-hidden>
            <defs>
              <linearGradient id={`fade-${gid}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" className="tt-area-top" />
                <stop offset="1" className="tt-area-end" />
              </linearGradient>
            </defs>
            <path d={`${line}L${x(list.length - 1).toFixed(1)},${priceBottom}L${x(0).toFixed(1)},${priceBottom}Z`} fill={`url(#fade-${gid})`} />
            <path d={line} className="tt-line" />
          </g>
        )}
        <g className="tt-axis" aria-hidden>
          <line x1={right + 0.5} x2={right + 0.5} y1={TOP - 4} y2={bottom} />
          <line x1={LEFT} x2={geo.w} y1={bottom + 0.5} y2={bottom + 0.5} />
          {geo.ticks
            // the mid's tag covers the axis where it sits: leave out a label it would hide
            .filter((v) => mid === null || Math.abs(y(v) - y(mid)) > 15)
            .map((v) => (
              <text key={v} x={right + 8} y={y(v)} dy="0.34em">
                {fmtPrice(v, ref)}
              </text>
            ))}
          {geo.times.map((t) => (
            <text key={t.i} x={x(t.i)} y={bottom + 16} textAnchor="middle">
              {t.label}
            </text>
          ))}
        </g>
      </>
    );
  }, [geo, list, ohlc, withVolume, gid, ref, mid]);

  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (px > geo.right || py < geo.TOP - 4 || py > geo.bottom) return setHover(null);
    const i = Math.max(0, Math.min(list.length - 1, Math.floor((px - LEFT) / geo.slot)));
    setHover({ i, y: Math.min(py, geo.priceBottom) });
  };

  const shownBar = hover ? list[hover.i] : list.at(-1);
  const prev = hover ? list[hover.i - 1] : list.at(-2);

  return (
    <div className="tt-chart" ref={box}>
      {!series && <div className="hd-skeleton absolute inset-3" aria-hidden />}
      {shownBar && (
        <div className="tt-legend tnum" aria-hidden>
          <span className="text-mute">{stamp(shownBar.t, interval)}</span>
          {ohlc ? (
            <>
              <span>
                <b>O</b> {fmtPrice(shownBar.o, ref)}
              </span>
              <span>
                <b>H</b> {fmtPrice(shownBar.h, ref)}
              </span>
              <span>
                <b>L</b> {fmtPrice(shownBar.l, ref)}
              </span>
              <span>
                <b>C</b> {fmtPrice(shownBar.c, ref)}
              </span>
              <span className="text-mute">{fmtPct(shownBar.c / shownBar.o - 1)}</span>
              {withVolume && shownBar.v !== null && (
                <span>
                  <b>Vol</b> {fmtVolume(shownBar.v)} {volumeUnit}
                </span>
              )}
            </>
          ) : (
            <>
              <span>
                <b>{series?.kind === "line" ? "Rate" : "Close"}</b> {fmtPrice(shownBar.c, ref)}
              </span>
              {prev && <span className="text-mute">{fmtPct(shownBar.c / prev.c - 1)}</span>}
            </>
          )}
        </div>
      )}
      {geo && (
        <svg width={geo.w} height={geo.h} role="img" aria-label={label} className="tt-svg" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)}>
          {layer}
          {mid !== null && mid > geo.lo && mid < geo.hi && (
            <g className="tt-mid" aria-hidden>
              <line x1={LEFT} x2={geo.right} y1={Math.round(geo.y(mid)) + 0.5} y2={Math.round(geo.y(mid)) + 0.5} />
              <rect x={geo.right + 1} y={geo.y(mid) - 10} width={AXIS_R - 2} height={20} rx={4} />
              <text x={geo.right + 8} y={geo.y(mid)} dy="0.34em">
                {fmtPrice(mid, ref)}
              </text>
            </g>
          )}
          {hover && (
            <g className="tt-cross" aria-hidden>
              <line x1={Math.round(geo.x(hover.i)) + 0.5} x2={Math.round(geo.x(hover.i)) + 0.5} y1={geo.TOP - 4} y2={geo.bottom} />
              <line x1={LEFT} x2={geo.right} y1={Math.round(hover.y) + 0.5} y2={Math.round(hover.y) + 0.5} />
              <rect x={geo.right + 1} y={hover.y - 10} width={AXIS_R - 2} height={20} rx={4} />
              <text x={geo.right + 8} y={hover.y} dy="0.34em">
                {fmtPrice(geo.lo + ((geo.priceBottom - hover.y) / (geo.priceBottom - geo.TOP)) * (geo.hi - geo.lo), ref)}
              </text>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}
