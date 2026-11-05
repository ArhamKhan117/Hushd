import type { DealView } from "@hushd/sdk";

export const CLASS_WORDS: Record<DealView["class"], string> = {
  atomic_pool: "Atomic, in the pool",
  bonded_hedge: "Bonded hedge",
  atomic_intents: "Atomic, NEAR Intents",
};

export const KIND_WORDS: Record<string, string> = { spot: "Spot", spot_hedge: "Spot + hedge", carry: "Cash and carry" };

/** One word for where a deal stands, from the desk's record. */
export function dealState(d: DealView): { word: string; tone: "ok" | "wait" | "bad" } {
  if (d.receipt?.outcome === "settled") return { word: "Settled", tone: "ok" };
  if (d.receipt?.outcome === "recovered") return { word: "Recovered", tone: "ok" };
  if (d.receipt?.outcome === "failed") return { word: "Failed", tone: "bad" };
  if (d.status === "hedge_pending") return { word: "Hedge pending", tone: "wait" };
  if (d.status === "matched") return { word: "Matched", tone: "wait" };
  return { word: "Unresolved", tone: "wait" };
}

export function when(ms: string | number): string {
  const d = new Date(Number(ms));
  return d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function StateDot({ tone }: { tone: "ok" | "wait" | "bad" }) {
  const c = tone === "ok" ? "bg-accent" : tone === "bad" ? "bg-danger" : "bg-warn";
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${c}`} />;
}
