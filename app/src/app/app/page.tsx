"use client";

import {
  awaitMatch,
  checkMatchedTerms,
  DeskApi,
  deskView,
  intake,
  intakeAttestation,
  makeNote,
  openRfq,
  packageRequest,
  settleAsTrader,
  type AgreedTerms,
  type IntakeAttestation,
  type IntakeResult,
  type PackageKind,
} from "@hushd/sdk";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { AttestationLine, IntakeProof, Segmented, Steps, type Step, type StepState } from "@/components/app/desk";
import { AmountCard, ErrorLine, Field, TokenSelect, TxLine } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { BusyLabel } from "@/components/ui/Spinner";
import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";
import { fmt, parseAmount, symbol, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

const KINDS = [
  { value: "spot", label: "Spot", hint: "Swap one token for another, settled privately in one call" },
  { value: "spot_hedge", label: "Spot + hedge", hint: "The swap plus a Hyperliquid short of what you buy, bonded by the maker" },
  { value: "carry", label: "Cash and carry", hint: "Buy with a stablecoin and short the perp of the same size, bonded by the maker" },
] as const satisfies readonly { value: PackageKind; label: string; hint: string }[];

const WINDOWS = [
  { value: "20000", label: "20 s" },
  { value: "45000", label: "45 s" },
  { value: "90000", label: "90 s" },
] as const;

type Phase = "sealing" | "committed" | "quoting" | "matched" | "settling" | "settled";
const ORDER: Phase[] = ["sealing", "committed", "quoting", "matched", "settling", "settled"];

interface Run {
  phase: Phase;
  failed?: Phase;
  rfqId?: number;
  rfqTx?: string;
  closesAtMs?: number;
  quotes?: number;
  dealId?: number;
  matchTx?: string;
  terms?: AgreedTerms;
  makerName?: string;
  settleStep?: string;
}

const SETTLE_WORDS: Record<string, string> = {
  planning: "Choosing your notes and making the maker's",
  waiting_plan: "Swapping sealed note openings with the maker",
  proving: "Proving your leg in this browser",
  waiting_settlement: "The maker submits both legs in one call",
  settled: "Settled",
};

function bySymbol(sym: string) {
  return TOKENS.find((t) => t.symbol.toLowerCase() === sym.toLowerCase())?.id;
}

export default function DeskPage() {
  const s = useHushd();
  const api = useMemo(() => new DeskApi(NETWORK.api), []);
  const [mode, setMode] = useState<"words" | "form">("words");
  const [att, setAtt] = useState<IntakeAttestation | null>(null);
  const [attError, setAttError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [drafted, setDrafted] = useState<IntakeResult | null>(null);

  const [kind, setKind] = useState<PackageKind>("spot");
  const [sellToken, setSellToken] = useState(TOKENS[0]!.id);
  const [sellInput, setSellInput] = useState("");
  const [buyToken, setBuyToken] = useState(TOKENS[1]!.id);
  const [minInput, setMinInput] = useState("");
  const [windowMs, setWindowMs] = useState<(typeof WINDOWS)[number]["value"]>("45000");

  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // only read while a quote window is open, ticked by the effect below
  const [now, setNow] = useState(0);

  useEffect(() => {
    intakeAttestation(NETWORK.api).then(
      (a) => {
        setAtt(a);
        if (!a.enabled) setMode("form");
      },
      (e: Error) => setAttError(e.message),
    );
  }, []);
  useEffect(() => {
    if (!run?.closesAtMs || run.phase !== "quoting") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [run?.closesAtMs, run?.phase]);

  const sellAmount = parseAmount(sellToken, sellInput);
  const minAmount = minInput.trim() === "" ? 0n : parseAmount(buyToken, minInput);
  const have = s.balances.get(sellToken) ?? 0n;
  const hedged = kind !== "spot";
  const buyInfo = TOKENS.find((t) => t.id === buyToken);
  const hedgeOk = !hedged || Boolean(buyInfo?.hedgeCoin);
  const canAsk = s.status === "ready" && sellAmount !== null && sellAmount <= have && minAmount !== null && sellToken !== buyToken && hedgeOk && !busy;

  const draft = async () => {
    setDrafting(true);
    setError(null);
    try {
      const r = await intake(NETWORK.api, text);
      setDrafted(r);
      const d = r.draft;
      setKind(d.kind);
      const sell = bySymbol(d.sell.symbol);
      const buy = bySymbol(d.buy.symbol);
      if (sell) setSellToken(sell);
      if (buy) setBuyToken(buy);
      setSellInput(d.sell.amount ?? "");
      setMinInput(d.min_receive ?? "");
      const w = WINDOWS.reduce((best, x) => (Math.abs(Number(x.value) - d.window_minutes * 60_000) < Math.abs(Number(best.value) - d.window_minutes * 60_000) ? x : best), WINDOWS[1]);
      setWindowMs(w.value);
      setMode("form");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const ask = async () => {
    if (!s.wallet || !s.identity || sellAmount === null || minAmount === null) return;
    setBusy(true);
    setError(null);
    let r: Run = { phase: "sealing" };
    const set = (patch: Partial<Run>) => {
      r = { ...r, ...patch };
      setRun(r);
    };
    set({});
    try {
      const draft = { kind, sell: { token: sellToken, amount: sellAmount }, buy: { token: buyToken, minAmount }, ...(drafted ? { text } : {}) };
      const { request, ask: makerAsk, refundBlinding } = packageRequest(s.identity, NETWORK, draft);
      const opened = await openRfq({ net: NETWORK, api, relayer: s.relayer, request, ask: makerAsk, windowMs: Number(windowMs) });
      set({ phase: "quoting", rfqId: opened.rfqId, closesAtMs: opened.closesAtMs, quotes: 0 });
      const match = await awaitMatch(api, s.identity, opened.rfqId, Number(windowMs) + 120_000, (t) => set({ quotes: t.quotes }));
      checkMatchedTerms(match.terms, draft);
      const makers = await deskView.makers(NETWORK).catch(() => []);
      const makerName = makers.find(([acc]) => acc === match.terms.maker)?.[1].name ?? match.terms.maker;
      set({ phase: "matched", dealId: match.dealId, matchTx: match.txHash, terms: match.terms, makerName });
      if (BigInt(match.terms.bond) > 0n) {
        const bondToken = NETWORK.bondToken ?? (await deskView.config(NETWORK)).bond_token;
        await s.wallet.expect(makeNote(s.identity.pk, bondToken, BigInt(match.terms.bond), refundBlinding), { memo: "Bond paid to you: the maker missed the hedge", dealId: String(match.dealId) });
      }
      const record = {
        dealId: match.dealId,
        rfqId: opened.rfqId,
        role: "trader" as const,
        kind,
        maker: match.terms.maker,
        class: match.terms.class,
        gave: match.terms.traderGives,
        got: match.terms.makerGives,
        bond: match.terms.bond,
        refundBlinding: refundBlinding.toString(),
        atMs: Date.now(),
      };
      await s.wallet.rememberDeal(record);
      set({ phase: "settling", settleStep: "planning" });
      await settleAsTrader({
        net: NETWORK,
        api,
        wallet: s.wallet,
        dealId: match.dealId,
        terms: match.terms,
        makerAddress: match.maker_address,
        refundBlinding,
        onStep: (step) => set({ settleStep: step }),
      });
      await s.wallet.rememberDeal({ ...record, settledAtMs: Date.now() });
      set({ phase: "settled" });
      void s.sync();
    } catch (e) {
      setRun({ ...r, failed: r.phase });
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setRun(null);
    setError(null);
    setDrafted(null);
    setSellInput("");
    setMinInput("");
  };

  const state = (p: Phase): StepState => {
    if (!run) return "todo";
    const at = ORDER.indexOf(run.phase);
    const i = ORDER.indexOf(p);
    if (run.failed === p) return "failed";
    if (i < at || (p === "settled" && run.phase === "settled")) return "done";
    return i === at && !run.failed ? "doing" : "todo";
  };

  const t = run?.terms;
  const steps: Step[] = run
    ? [
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
        { key: "settled", label: hedged ? "Spot settled; the hedge leg is next" : "Settled", state: state("settled") },
      ]
    : [];

  return (
    <AppShell title="Desk" subtitle="Ask makers for a price without showing your hand. Your request is sealed to an enclave, matched there and settled privately on NEAR.">
      {s.status !== "ready" ? (
        <SignInPanel />
      ) : run ? (
        <div className="grid max-w-[620px] gap-5">
          <div className="hd-card p-5 sm:p-6">
            <Steps steps={steps} />
          </div>
          {run.phase === "settled" && t && run.dealId !== undefined && (
            <div className="hd-card grid gap-3 p-5 sm:p-6">
              <p className="t-label">Receipt</p>
              <p className="text-[15px] text-foreground">
                You gave {fmt(t.traderGives.token, BigInt(t.traderGives.amount))} {symbol(t.traderGives.token)} and received {fmt(t.makerGives.token, BigInt(t.makerGives.amount))} {symbol(t.makerGives.token)}, privately.
              </p>
              <p className="text-[13px] text-mute">
                {hedged
                  ? `${run.makerName} now opens the hedge on Hyperliquid${IS_TESTNET ? " testnet" : ""} from a per-deal address only the desk's Chain Signatures can sign for. If it misses the deadline, its bond is paid to you as a private note.`
                  : "The chain shows that deal #" + run.dealId + " settled, not who traded or how much."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href={`/app/deals/${run.dealId}`} className="btn btn-ghost btn-sm">
                  Open deal #{run.dealId}
                </Link>
                <Link href={`/app/prove?deal=${run.dealId}`} className="btn btn-ghost btn-sm">
                  Prove this payment
                </Link>
              </div>
            </div>
          )}
          {run.matchTx && <TxLine hash={run.matchTx}>The enclave&apos;s match is on chain.</TxLine>}
          <ErrorLine error={error} />
          {(run.phase === "settled" || run.failed) && (
            <button type="button" className="btn btn-ink btn-lg" onClick={reset}>
              New request
            </button>
          )}
        </div>
      ) : (
        <div className="grid max-w-[620px] gap-5">
          <Segmented
            label="How to ask"
            value={mode}
            onChange={setMode}
            options={[
              { value: "words", label: "Describe it" },
              { value: "form", label: "Fill the form" },
            ]}
          />

          {mode === "words" ? (
            <div className="grid gap-3">
              <div className="hd-inputcard p-4 sm:p-5">
                <label className="t-label" htmlFor="intake">
                  Your trade, in your words
                </label>
                <textarea
                  id="intake"
                  rows={4}
                  className="mt-2 w-full resize-none bg-transparent text-[16px] leading-relaxed text-foreground outline-none placeholder:text-faint"
                  placeholder="Sell 500 USDC for BTC at the best price."
                  value={text}
                  maxLength={600}
                  onChange={(e) => setText(e.target.value)}
                />
              </div>
              {attError ? <p className="text-[12.5px] text-mute">The intake is unavailable right now ({attError}). The form works without it.</p> : <AttestationLine att={att} />}
              <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!att?.enabled || text.trim().length < 6 || drafting} onClick={draft} aria-busy={drafting}>
                <BusyLabel busy={drafting} busyText="Drafting inside the TEE…">
                  Draft my request
                </BusyLabel>
              </button>
              <p className="text-[12.5px] text-mute">The model only drafts. You check every number in the form before anything is sent.</p>
            </div>
          ) : (
            <div className="grid gap-4">
              {drafted && (
                <div className="grid gap-2">
                  <p className="text-[13.5px] text-soft">Drafted from your words{drafted.draft.notes ? `: ${drafted.draft.notes}` : "."} Check it before you ask.</p>
                  <IntakeProof proof={drafted.proof} />
                </div>
              )}
              <Field label="Package">
                <Segmented label="Package" value={kind} onChange={setKind} options={KINDS} />
              </Field>
              <AmountCard
                label="You sell"
                value={sellInput}
                onChange={setSellInput}
                token={sellToken}
                onToken={setSellToken}
                balances={s.balances}
                note={
                  <>
                    Private balance: {fmt(sellToken, have)} {symbol(sellToken)}
                    {have === 0n && (
                      <>
                        {" · "}
                        <Link href="/app/balance/add" className="text-foreground underline decoration-line-strong underline-offset-4">
                          Add some
                        </Link>
                      </>
                    )}
                  </>
                }
              />
              <div className="grid gap-4 sm:grid-cols-[auto_1fr] sm:items-end">
                <Field label="You buy">
                  <TokenSelect value={buyToken} onChange={setBuyToken} label="Buy token" />
                </Field>
                <Field label={`Least you accept, in ${symbol(buyToken)}`} hint="Sealed: only the enclave reads it. Leave empty to take the best quote.">
                  <input className="hd-input tnum w-full" inputMode="decimal" placeholder="Best quote" value={minInput} onChange={(e) => setMinInput(e.target.value.replace(/[^\d.,]/g, ""))} />
                </Field>
              </div>
              <Field label="Quote window">
                <Segmented label="Quote window" value={windowMs} onChange={setWindowMs} options={WINDOWS} />
              </Field>
              {!hedgeOk && <p className="text-[13px] text-warn">{symbol(buyToken)} has no Hyperliquid perp, so it cannot be hedged. Pick Spot or another token.</p>}
              <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!canAsk} onClick={ask} aria-busy={busy}>
                <BusyLabel busy={busy} busyText="Sealing…">
                  {sellToken === buyToken ? "Pick two different tokens" : sellAmount !== null && sellAmount > have ? "More than your private balance" : "Ask for quotes"}
                </BusyLabel>
              </button>
              <ErrorLine error={error} />
            </div>
          )}
          {mode === "words" && <ErrorLine error={error} />}
        </div>
      )}
    </AppShell>
  );
}
