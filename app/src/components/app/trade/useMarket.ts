"use client";

/**
 * Live reads for the Trade screen. Prices come from the Hushd API's market routes
 * (Hyperliquid mainnet, cached there a few seconds); desk state comes from chain. Every
 * poll pauses while the tab is hidden and picks up again when it is shown.
 */
import { crossRate, candleCloses, deskView, hourStats, latestBlock, MarketApi, readMakerRecords, type Candle, type CandleInterval, type DealView, type DeskConfig, type HourStats, type MakerRecord, type MakerView, type MarketMids, type PricePoint } from "@hushd/sdk";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { NETWORK } from "@/lib/hushd/config";
import type { Pair } from "./pairs";

export const market = new MarketApi(NETWORK.api);

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** When `data` was last read. */
  at: number;
}

const clocks = new Map<number, { now: number; subs: Set<() => void>; timer: ReturnType<typeof setInterval> | null }>();

/** One ticker per period, shared by every component that reads it, running while any does. */
function subscribeClock(ms: number, onTick: () => void) {
  let clock = clocks.get(ms);
  if (!clock) clocks.set(ms, (clock = { now: Date.now(), subs: new Set(), timer: null }));
  const c = clock;
  if (c.subs.size === 0) c.now = Date.now();
  c.subs.add(onTick);
  c.timer ??= setInterval(() => {
    c.now = Date.now();
    c.subs.forEach((f) => f());
  }, ms);
  return () => {
    c.subs.delete(onTick);
    if (c.subs.size === 0 && c.timer) {
      clearInterval(c.timer);
      c.timer = null;
    }
  };
}

/** The time, ticking every `ms`; 0 in the server render, so the server and the browser agree. */
export function useNow(ms: number): number {
  const subscribe = useCallback((onTick: () => void) => subscribeClock(ms, onTick), [ms]);
  return useSyncExternalStore(
    subscribe,
    () => clocks.get(ms)?.now ?? 0,
    () => 0,
  );
}

/**
 * Call `load` now and every `ms` while the page is visible. A change of `key` starts over and
 * shows nothing until the new answer (never the old pair's numbers), unless `keep` is set.
 */
export function usePoll<T>(load: () => Promise<T>, ms: number, key: string, keep = false): Polled<T> {
  const [state, setState] = useState<Polled<T> & { key: string }>({ data: null, error: null, at: 0, key });
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      try {
        const data = await loadRef.current();
        if (live) setState({ data, error: null, at: Date.now(), key });
      } catch (e) {
        // keep the last good answer beside the error: a blip should not blank the screen
        if (live) setState((s) => ({ ...(s.key === key || keep ? s : { data: null, at: 0 }), error: (e as Error).message, key }));
      }
      if (live) timer = setTimeout(tick, ms);
    };
    const onShow = () => document.visibilityState === "visible" && void tick();
    void tick();
    document.addEventListener("visibilitychange", onShow);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [key, ms, keep]);
  return state.key === key || keep ? state : { data: null, error: null, at: 0 };
}

export const useMids = () => usePoll<MarketMids>(() => market.mids(), 5_000, "mids");

export type Series = { kind: "ohlc"; candles: Candle[] } | { kind: "line"; points: PricePoint[] };

async function pairSeries(p: Pair, interval: CandleInterval, limit: number): Promise<{ series: Series; at: number }> {
  if (!p.quoteCoin) {
    const r = await market.candles(p.baseCoin, interval, limit);
    return { series: { kind: "ohlc", candles: r.candles }, at: r.at };
  }
  const [b, q] = await Promise.all([market.candles(p.baseCoin, interval, limit), market.candles(p.quoteCoin, interval, limit)]);
  return { series: { kind: "line", points: crossRate(b.candles, q.candles) }, at: Math.min(b.at, q.at) };
}

/** The chart's series: Hyperliquid candles for a dollar pair, closes divided for a cross rate. */
export function useSeries(p: Pair, interval: CandleInterval) {
  return usePoll(() => pairSeries(p, interval, 180), interval === "1m" ? 5_000 : 10_000, `${p.id}:${interval}`);
}

/** The last hour of the pair from one-minute candles: change, range and realized volatility. */
export function useHour(p: Pair) {
  return usePoll<HourStats | null>(
    async () => {
      const { series } = await pairSeries(p, "1m", 75);
      return series.kind === "ohlc" ? hourStats(series.candles) : hourStats(series.points);
    },
    15_000,
    `hour:${p.id}`,
  );
}

export const seriesCloses = (s: Series): PricePoint[] => (s.kind === "ohlc" ? candleCloses(s.candles) : s.points);

export interface DeskPublic {
  makers: [string, MakerView][];
  stats: Record<string, unknown>;
  config: DeskConfig;
  recent: DealView[];
  /** Each maker's record over its recent deals (`readMakerRecords`), the one a request checks. */
  records: Map<string, MakerRecord>;
}

/** What anyone can read of the desk: makers, counters, settings, the latest deals and each maker's record. */
export function useDeskPublic() {
  return usePoll<DeskPublic>(
    async () => {
      // the records read the desk's deals newest first (at least one page, older ones back to a week): the latest are the panel's list
      const [makers, stats, config, { records, deals }] = await Promise.all([deskView.makers(NETWORK), deskView.stats(NETWORK), deskView.config(NETWORK), readMakerRecords(NETWORK)]);
      return { makers, stats, config, records, recent: [...deals].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 12) };
    },
    30_000,
    "desk",
  );
}

/** The desk's record of each of these deals (the ones this wallet took part in). */
export function useDealViews(ids: number[]) {
  const key = ids.join(",");
  return usePoll<Map<number, DealView>>(
    async () => {
      const list = key ? key.split(",").map(Number) : [];
      const views = await Promise.all(list.map((id) => deskView.deal(NETWORK, id).catch(() => null)));
      return new Map(views.flatMap((v, i) => (v ? [[list[i]!, v] as const] : [])));
    },
    10_000,
    `deals:${key}`,
    true,
  );
}

export interface Health {
  ok: boolean;
  detail: string;
}

async function health(service: "relayer" | "indexer"): Promise<Health> {
  const r = await fetch(`${NETWORK.api.replace(/\/$/, "")}/health/${service}`, { signal: AbortSignal.timeout(8_000) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; behind?: number; lanes?: { lanes?: number }; error?: string };
  if (service === "indexer") return { ok: Boolean(j.ok), detail: j.ok ? (j.behind ? `${j.behind} blocks behind` : "in sync") : (j.error ?? "down") };
  return { ok: Boolean(j.ok), detail: j.ok ? `${j.lanes?.lanes ?? 1} lanes` : (j.error ?? "down") };
}

export interface Network {
  block: { height: number; timestampMs: number };
  enclave: { sign_key: string | null; enc_key: string | null; project: string };
  relayer: Health;
  indexer: Health;
}

// the enclave changes only through the desk's timelock: read it once a minute, not every tick
let enclaveRead: { at: number; value: Network["enclave"] } | null = null;
async function enclave(): Promise<Network["enclave"]> {
  if (!enclaveRead || Date.now() - enclaveRead.at > 60_000) enclaveRead = { at: Date.now(), value: await deskView.enclave(NETWORK) };
  return enclaveRead.value;
}

/** The status bar's reads: the latest final block, the enclave the desk is pinned to, the relayer and the indexer. */
export function useNetwork() {
  return usePoll<Network>(
    async () => {
      const down = (e: Error): Health => ({ ok: false, detail: e.message });
      const [block, encl, relayer, indexer] = await Promise.all([latestBlock(NETWORK), enclave(), health("relayer").catch(down), health("indexer").catch(down)]);
      return { block, enclave: encl, relayer, indexer };
    },
    10_000,
    "network",
  );
}
