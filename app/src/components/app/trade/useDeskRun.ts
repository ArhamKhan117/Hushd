"use client";

/**
 * One request on the desk, from sealing to settlement: the same flow as the Desk page
 * (`app/src/app/app/page.tsx`), step for step, kept in one place so a screen that asks for
 * quotes does not carry its own copy. `packageRequest` seals the request, `openRfq` commits it
 * through the relayer, `awaitMatch` waits for the enclave, `checkMatchedTerms` refuses a
 * match below the request, and `settleAsTrader` settles both legs in the pool and moves the
 * note the maker paid to this deal's one-time address into the balance. The wallet remembers
 * the deal (and the bond note it may be owed) in its encrypted store.
 */
import { awaitMatch, checkMatchedTerms, MATCH_WAIT_MS, DeskApi, deskView, makeNote, MarketApi, marketFloor, openRfq, packageRequest, settleAsTrader, tokenInfo, type AgreedTerms, type PackageDraft } from "@hushd/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Step, StepState } from "@/components/app/desk";
import { NETWORK } from "@/lib/hushd/config";
import { fmt, symbol } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

export type Phase = "sealing" | "committed" | "quoting" | "matched" | "settling" | "settled";
const ORDER: Phase[] = ["sealing", "committed", "quoting", "matched", "settling", "settled"];

export interface Run {
  /** This browser's number for the request, in this session. */
  key: number;
  draft: PackageDraft;
  windowMs: number;
  startedAtMs: number;
  phase: Phase;
  failed?: Phase;
  error?: string;
  rfqId?: number;
  closesAtMs?: number;
  quotes?: number;
  dealId?: number;
  matchTx?: string;
  terms?: AgreedTerms;
  makerName?: string;
  settleStep?: string;
  /** Whether the deal's tokens reached the balance ("waiting": the next sync moves them). */
  moved?: "moved" | "waiting" | "unsettled";
  /** Why the move did not go out yet, when it did not. */
  moveReason?: string;
  /** The private send that moved the deal's tokens from its one-time address into the balance. */
  moveTx?: string;
}

const SETTLE_WORDS: Record<string, string> = {
  planning: "Choosing your notes and making the maker's",
  waiting_plan: "Swapping sealed note openings with the maker",
  proving: "Proving your leg in this browser",
  waiting_settlement: "The maker submits both legs in one call",
  moving: "Moving the tokens into your balance",
  settled: "Settled",
};

export function useDeskRun() {
  const s = useHushd();
  const api = useMemo(() => new DeskApi(NETWORK.api), []);
  const [runs, setRuns] = useState<Run[]>([]);
  const [shown, setShown] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  // only read while a quote window is open, ticked by the effect below
  const [now, setNow] = useState(0);
  const seq = useRef(0);

  const quoting = runs.some((r) => r.phase === "quoting" && !r.failed);
  useEffect(() => {
    if (!quoting) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [quoting]);

  const ask = useCallback(
    async (draft: PackageDraft, windowMs: number) => {
      if (!s.wallet || !s.identity) return;
      const wallet = s.wallet;
      const identity = s.identity;
      setBusy(true);
      let r: Run = { key: ++seq.current, draft, windowMs, startedAtMs: Date.now(), phase: "sealing" };
      const set = (patch: Partial<Run>) => {
        r = { ...r, ...patch };
        const next = r;
        setRuns((all) => [next, ...all.filter((x) => x.key !== next.key)]);
      };
      set({});
      setShown(r.key);
      try {
        // an empty minimum takes the best quote, but never one below 3% under the market price
        if (draft.buy.minAmount === 0n) {
          const { mids } = await new MarketApi(NETWORK.api).mids();
          draft = { ...draft, buy: { ...draft.buy, minAmount: marketFloor(mids, tokenInfo(NETWORK, draft.sell.token), draft.sell.amount, tokenInfo(NETWORK, draft.buy.token)) } };
          set({ draft });
        }
        const { request, ask: makerAsk, refundBlinding, dealIdentity } = packageRequest(identity, NETWORK, draft);
        const opened = await openRfq({ net: NETWORK, api, relayer: s.relayer, request, ask: makerAsk, windowMs });
        set({ phase: "quoting", rfqId: opened.rfqId, closesAtMs: opened.closesAtMs, quotes: 0 });
        const match = await awaitMatch(api, dealIdentity, opened.rfqId, windowMs + MATCH_WAIT_MS, (t) => set({ quotes: t.quotes }));
        checkMatchedTerms(match.terms, draft);
        const makers = await deskView.makers(NETWORK).catch(() => []);
        const makerName = makers.find(([acc]) => acc === match.terms.maker)?.[1].name ?? match.terms.maker;
        set({ phase: "matched", dealId: match.dealId, matchTx: match.txHash, terms: match.terms, makerName });
        if (BigInt(match.terms.bond) > 0n) {
          const bondToken = NETWORK.bondToken ?? (await deskView.config(NETWORK)).bond_token;
          await wallet.expect(makeNote(identity.pk, bondToken, BigInt(match.terms.bond), refundBlinding), { memo: "Bond paid to you: the maker missed the hedge", dealId: String(match.dealId) });
        }
        const record = {
          dealId: match.dealId,
          rfqId: opened.rfqId,
          role: "trader" as const,
          kind: draft.kind,
          maker: match.terms.maker,
          class: match.terms.class,
          gave: match.terms.traderGives,
          got: match.terms.makerGives,
          bond: match.terms.bond,
          refundBlinding: refundBlinding.toString(),
          atMs: Date.now(),
        };
        await wallet.rememberDeal(record);
        set({ phase: "settling", settleStep: "planning" });
        const { moved } = await settleAsTrader({
          net: NETWORK,
          api,
          wallet,
          dealId: match.dealId,
          terms: match.terms,
          makerAddress: match.maker_address,
          refundBlinding,
          onStep: (step) => set({ settleStep: step }),
        });
        await wallet.rememberDeal({ ...record, settledAtMs: Date.now() });
        set({ phase: "settled", moved: moved.state, ...(moved.state === "moved" && moved.txHash ? { moveTx: moved.txHash } : {}), ...(moved.state === "waiting" && moved.reason ? { moveReason: moved.reason } : {}) });
        void s.sync();
      } catch (e) {
        set({ failed: r.phase, error: (e as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [api, s],
  );

  /** Back to an empty ticket; the request stays in this session's list. */
  const reset = useCallback(() => setShown(null), []);

  const run = runs.find((r) => r.key === shown) ?? null;
  return { run, runs, busy, now, ask, reset };
}

/** Where the request stands, as the Desk page shows it. */
export function runSteps(run: Run, now: number): Step[] {
  const state = (p: Phase): StepState => {
    const at = ORDER.indexOf(run.phase);
    const i = ORDER.indexOf(p);
    if (run.failed === p) return "failed";
    if (i < at || (p === "settled" && run.phase === "settled")) return "done";
    return i === at && !run.failed ? "doing" : "todo";
  };
  const t = run.terms;
  const hedged = run.draft.kind !== "spot";
  return [
    { key: "sealing", label: "Sealed to the matcher enclave", state: state("sealing"), detail: "Your limit is readable only inside the enclave. Makers see the pair, the side and the size." },
    {
      key: "committed",
      label: run.rfqId !== undefined ? `Request #${run.rfqId} committed on the desk` : "Committing the request's hash on the desk",
      state: run.rfqId !== undefined ? "done" : state("committed"),
      detail: "Only its sha256 goes on chain, sent by the relayer.",
    },
    {
      key: "quoting",
      label: `Makers quoting${run.quotes ? `: ${run.quotes} sealed quote${run.quotes > 1 ? "s" : ""}` : ""}`,
      state: state("quoting"),
      detail: run.phase === "quoting" && run.closesAtMs ? (run.closesAtMs > now ? `Window closes in ${Math.ceil((run.closesAtMs - now) / 1000)} s` : "Window closed; the enclave is matching") : "Each quote is sealed to the enclave and signed by its maker.",
    },
    {
      key: "matched",
      label: run.dealId !== undefined ? `Matched in the enclave: deal #${run.dealId} with ${run.makerName}` : "Matched in the enclave",
      state: state("matched"),
      detail: t ? `You give ${fmt(t.traderGives.token, BigInt(t.traderGives.amount))} ${symbol(t.traderGives.token)} and get ${fmt(t.makerGives.token, BigInt(t.makerGives.amount))} ${symbol(t.makerGives.token)}. Only the deal's hash is public.` : "The enclave picks the best quote inside your limit and signs the match.",
    },
    {
      key: "settling",
      label: "Settling privately in the pool",
      state: state("settling"),
      detail: run.phase === "settling" && run.settleStep ? SETTLE_WORDS[run.settleStep] : "Both legs go through the pool in one call: both happen or neither does.",
    },
    {
      key: "settled",
      label: hedged ? "Spot settled; the hedge leg is next" : "Settled",
      state: state("settled"),
      ...(run.moved === "moved" ? { detail: "The tokens are in your private balance." } : run.moved === "waiting" ? { detail: `The tokens are on their way into your balance: the next sync moves them.${run.moveReason ? ` Last try: ${run.moveReason}` : ""}` } : {}),
    },
  ];
}

/** One word for where a request stands, for a table row. */
export function runWord(run: Run, now: number): { word: string; tone: "ok" | "wait" | "bad" } {
  if (run.failed) return { word: run.failed === "quoting" ? "No deal" : "Stopped", tone: "bad" };
  if (run.phase === "settled") return { word: "Settled", tone: "ok" };
  if (run.phase === "quoting") return { word: run.closesAtMs && run.closesAtMs > now ? `Quoting, ${Math.ceil((run.closesAtMs - now) / 1000)} s` : "Matching", tone: "wait" };
  if (run.phase === "settling" || run.phase === "matched") return { word: "Settling", tone: "wait" };
  return { word: "Sealing", tone: "wait" };
}
