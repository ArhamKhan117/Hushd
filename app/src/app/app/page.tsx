"use client";

import { intake, intakeAttestation, type IntakeAttestation, type IntakeResult, type PackageKind } from "@hushd/sdk";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { AttestationLine, IntakeProof, Segmented, Steps, type Step } from "@/components/app/desk";
import { AmountCard, ErrorLine, Field, TokenSelect, TxLine } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { HedgedNote } from "@/components/app/trade/Ticket";
import { runSteps, useDeskRun } from "@/components/app/trade/useDeskRun";
import { BusyLabel } from "@/components/ui/Spinner";
import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";
import { fmt, parseAmount, symbol, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

const KINDS = [
  { value: "spot", label: "Spot", hint: "Swap one token for another, settled privately in one call" },
  { value: "spot_hedge", label: "Spot + hedge", hint: "Experimental: the swap, plus a hedge order the maker places for its own account, with its bond at stake" },
  { value: "carry", label: "Cash and carry", hint: "Experimental: buy with a stablecoin, plus the same bonded hedge order, placed for the maker's own account" },
] as const satisfies readonly { value: PackageKind; label: string; hint: string }[];

const WINDOWS = [
  { value: "20000", label: "20 s" },
  { value: "45000", label: "45 s" },
  { value: "90000", label: "90 s" },
] as const;

function bySymbol(sym: string) {
  return TOKENS.find((t) => t.symbol.toLowerCase() === sym.toLowerCase())?.id;
}

export default function DeskPage() {
  const s = useHushd();
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

  // the trade flow itself is shared with the Trade screen (components/app/trade/useDeskRun)
  const { run, busy, now, ask: askRun, reset: resetRun } = useDeskRun();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    intakeAttestation(NETWORK.api).then(
      (a) => {
        setAtt(a);
        if (!a.enabled) setMode("form");
      },
      (e: Error) => setAttError(e.message),
    );
  }, []);

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
    if (sellAmount === null || minAmount === null) return;
    setError(null);
    await askRun({ kind, sell: { token: sellToken, amount: sellAmount }, buy: { token: buyToken, minAmount }, ...(drafted ? { text } : {}) }, Number(windowMs));
  };

  const reset = () => {
    resetRun();
    setError(null);
    setDrafted(null);
    setSellInput("");
    setMinInput("");
  };

  const t = run?.terms;
  const steps: Step[] = run ? runSteps(run, now) : [];
  const runHedged = run ? run.draft.kind !== "spot" : hedged;

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
                {runHedged
                  ? `You hold what you bought. ${run.makerName} now places its hedge order on Hyperliquid${IS_TESTNET ? " testnet" : ""} for its own account, signed by the desk's Chain Signatures from this deal's address. If the order misses its deadline, the maker's bond is paid to you as a private note.`
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
          <ErrorLine error={error ?? run.error ?? null} />
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
              {attError ? (
                <p className="text-[12.5px] text-mute" title={attError}>
                  The intake is off for now: the model&apos;s attestation could not be checked. The form works without it.
                </p>
              ) : (
                <AttestationLine att={att} />
              )}
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
              <Field label="Package" hint={hedged ? <HedgedNote /> : undefined}>
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
                <Field label={`Least you accept, in ${symbol(buyToken)}`} hint="Sealed: only the enclave reads it. Leave it empty to take the best quote, never less than 3% under the market price.">
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
