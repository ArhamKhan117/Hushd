import { LAPSE_MAX_RATE, LAPSE_MIN_DEALS, lapsesTooOften, RECORD_WINDOW, type MakerRecord } from "@hushd/sdk";

/** A lapse rate in whole percent, e.g. "5%". */
export const lapsePercent = (r: MakerRecord) => `${Math.round((r.lapseRate ?? 0) * 100)}%`;

/** Where a maker stands with requests, from its record. */
export function recordStanding(r: MakerRecord | undefined): { tone: "ok" | "wait" | "bad"; words: string } {
  if (lapsesTooOften(r)) return { tone: "bad", words: `Requests skip it: more than ${LAPSE_MAX_RATE * 100}% of its recent deals lapsed` };
  if (!r || r.ended === 0) return { tone: "ok", words: "None of its deals ended in the past week" };
  if (r.ended < LAPSE_MIN_DEALS) return { tone: "ok", words: `Requests ask it; judged once ${LAPSE_MIN_DEALS} of its deals have ended` };
  return { tone: "ok", words: "Requests ask it" };
}

/** One sentence on how a maker's record is counted and what it costs to lapse. */
export const RECORD_RULE = `Each maker's record counts its last ${RECORD_WINDOW} deals that ended in the past week, read from the desk's public receipts: settled, or lapsed (expired without settling, or a hedge it missed). A request skips a maker that let more than ${LAPSE_MAX_RATE * 100}% lapse, once ${LAPSE_MIN_DEALS} have ended.`;
