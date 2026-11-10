/**
 * Each maker's record, read from the desk's own deals.
 *
 * After a match the trader hands over its proven leg first and the maker submits both, so
 * a maker holds a last look until the deal expires: it can let the deal lapse when the price
 * moves against it. Every deal ends with a public receipt, so the lapse is public too. This
 * counts, for each maker, how its recent deals ended, and `openRfq` stops asking a maker
 * that lets too many lapse (`makersToAsk`).
 *
 * The desk cannot tell which side stopped (`desk.expire` says so), so a deal the trader
 * walked away from counts against the maker too. The minimum sample and the threshold
 * leave room for that; the age limit lets a skipped maker back once its lapses are old.
 */
import type { DealView, MakerView } from "./desk.js";
import type { HushdNetwork } from "./network.js";
import { view } from "./rpc.js";

/** How many of a maker's latest ended deals its record counts. */
export const RECORD_WINDOW = 20;
/** Deals matched longer ago than this no longer count. */
export const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A maker is judged only once this many of its deals have ended: new makers are asked. */
export const LAPSE_MIN_DEALS = 5;
/** A maker whose recent lapse rate is above this is not asked. */
export const LAPSE_MAX_RATE = 0.25;
/** How many deals `readMakerRecords` reads at most (newest first, 100 a call). */
export const RECORD_SCAN_LIMIT = 500;

/** How one deal ended for its maker. */
export type DealEnd = "settled" | "lapsed" | "missed_hedge" | "open";

export interface MakerRecord {
  /** Ended deals counted: the maker's latest, at most `RECORD_WINDOW`, none older than `RECORD_MAX_AGE_MS`. */
  ended: number;
  settled: number;
  /** Deals it did not carry through: expired without settling, or a hedge it missed. */
  lapsed: number;
  /** Of `lapsed`, hedged deals whose hedge missed, so its bond went to the trader. */
  missedHedges: number;
  /** Its deals still under way in the same period: not counted either way. */
  open: number;
  /** `lapsed / ended`, or null before any deal ended. */
  lapseRate: number | null;
  /** The ids of the ended deals counted, newest first, so anyone can check them. */
  dealIds: string[];
}

export interface LapseRule {
  minDeals: number;
  maxRate: number;
}

export const LAPSE_RULE: LapseRule = { minDeals: LAPSE_MIN_DEALS, maxRate: LAPSE_MAX_RATE };

/** How a deal ended for its maker, from its public status and receipt. */
export function dealEnd(d: DealView, nowMs: number): DealEnd {
  const outcome = d.receipt?.outcome;
  if (d.status === "closed" && outcome === "settled") return "settled";
  if (d.status === "closed" && outcome === "failed") return "lapsed";
  // a missed hedge: the bond is taken from the maker, paid out or held for the trader
  if ((d.status === "closed" && outcome === "recovered") || d.status === "slashing" || d.status === "slash_refused") return "missed_hedge";
  // the desk refuses a settlement after expiry: a matched deal past it has lapsed, marked or not
  if (d.status === "matched" && nowMs > Number(d.expires_at_ms)) return "lapsed";
  return "open";
}

const emptyRecord = (): MakerRecord => ({ ended: 0, settled: 0, lapsed: 0, missedHedges: 0, open: 0, lapseRate: null, dealIds: [] });

/** Every maker's record from a list of deals (any order). */
export function makerRecords(deals: readonly DealView[], opts: { nowMs?: number; window?: number; maxAgeMs?: number } = {}): Map<string, MakerRecord> {
  const now = opts.nowMs ?? Date.now();
  const window = opts.window ?? RECORD_WINDOW;
  const since = now - (opts.maxAgeMs ?? RECORD_MAX_AGE_MS);
  const records = new Map<string, MakerRecord>();
  const newestFirst = [...deals].sort((a, b) => Number(b.id) - Number(a.id));
  for (const d of newestFirst) {
    if (Number(d.matched_at_ms) < since) continue;
    let r = records.get(d.maker);
    if (!r) records.set(d.maker, (r = emptyRecord()));
    const end = dealEnd(d, now);
    if (end === "open") {
      r.open++;
      continue;
    }
    if (r.ended >= window) continue;
    r.ended++;
    r.dealIds.push(d.id);
    if (end === "settled") r.settled++;
    else {
      r.lapsed++;
      if (end === "missed_hedge") r.missedHedges++;
    }
  }
  for (const r of records.values()) r.lapseRate = r.ended > 0 ? r.lapsed / r.ended : null;
  return records;
}

/** True when a maker's record is long enough to judge and its lapse rate is above the threshold. */
export function lapsesTooOften(r: MakerRecord | undefined, rule: LapseRule = LAPSE_RULE): boolean {
  return Boolean(r && r.ended >= rule.minDeals && r.lapsed / r.ended > rule.maxRate);
}

/**
 * The makers one request asks: active ones with a usable key, minus those that lapse too
 * often, the best bonded first, at most `limit`. `skipped` lists the ones left out for
 * their record.
 */
export function makersToAsk(
  listed: readonly [string, MakerView][],
  records: ReadonlyMap<string, MakerRecord>,
  limit: number,
  rule: LapseRule = LAPSE_RULE,
): { ask: [string, MakerView][]; skipped: string[] } {
  const usable = listed.filter(([, m]) => m.active && /^0x[0-9a-fA-F]{64}$/.test(m.enc_key));
  const skipped = usable.filter(([acc]) => lapsesTooOften(records.get(acc), rule)).map(([acc]) => acc);
  const ask = usable
    .filter(([acc]) => !skipped.includes(acc))
    .sort(([, a], [, b]) => (BigInt(b.bond) > BigInt(a.bond) ? 1 : BigInt(b.bond) < BigInt(a.bond) ? -1 : 0))
    .slice(0, limit);
  return { ask, skipped };
}

/**
 * Read the desk's recent deals, newest first, back to `RECORD_MAX_AGE_MS` (at most
 * `scanLimit` deals), and every maker's record from them. `deals` is what was read.
 */
export async function readMakerRecords(
  net: HushdNetwork,
  opts: { nowMs?: number; window?: number; maxAgeMs?: number; scanLimit?: number } = {},
): Promise<{ records: Map<string, MakerRecord>; deals: DealView[] }> {
  const now = opts.nowMs ?? Date.now();
  const since = now - (opts.maxAgeMs ?? RECORD_MAX_AGE_MS);
  const scanLimit = opts.scanLimit ?? RECORD_SCAN_LIMIT;
  const deals: DealView[] = [];
  let from: string | null = null;
  while (deals.length < scanLimit) {
    const limit = Math.min(100, scanLimit - deals.length);
    const page: DealView[] = await view<DealView[]>(net, net.desk!, "deals", { from_index: from, limit });
    deals.push(...page);
    const oldest = page.at(-1);
    if (page.length < limit || !oldest || oldest.id === "0" || Number(oldest.matched_at_ms) < since) break;
    from = oldest.id;
  }
  return { records: makerRecords(deals, { ...opts, nowMs: now }), deals };
}
