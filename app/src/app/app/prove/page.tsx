"use client";

import { artifactsAt, encodeProof, proveFunds, proveReceipt, proveVolume, type Payment } from "@hushd/sdk";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Segmented } from "@/components/app/desk";
import { AmountCard, ErrorLine, Field, TokenSelect } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { BusyLabel } from "@/components/ui/Spinner";
import { Select } from "@/components/ui/Select";
import { CIRCUITS_BASE, NETWORK } from "@/lib/hushd/config";
import { when } from "@/lib/hushd/deal";
import { fmt, parseAmount, symbol, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

type What = "exact" | "atleast" | "funds" | "volume";

const WHATS = [
  { value: "exact", label: "Exact payment" },
  { value: "atleast", label: "Paid at least" },
  { value: "funds", label: "Funds held" },
  { value: "volume", label: "OTC volume" },
] as const satisfies readonly { value: What; label: string }[];

const EXPIRY = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
] as const;

/** When a proof made now for `days` days stops holding. */
const expiryIn = (days: number) => Date.now() + days * 86_400_000;

const READER = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

function paymentLabel(p: Payment) {
  const what = `${fmt(p.token, p.made.amount)} ${symbol(p.token)}`;
  return p.kind === "deal" ? `Deal #${p.dealId}: ${what}` : `Sent ${what}${p.to ? ` to ${p.to.slice(0, 12)}…` : ""}`;
}

function ProveInner() {
  const s = useHushd();
  const params = useSearchParams();
  const [what, setWhat] = useState<What>(params.get("deal") ? "exact" : "exact");
  const [reader, setReader] = useState("");
  const [days, setDays] = useState<(typeof EXPIRY)[number]["value"]>("7");
  const [pick, setPick] = useState<number | null>(null);
  const [minInput, setMinInput] = useState("");
  const [showPayee, setShowPayee] = useState(false);
  const [token, setToken] = useState(TOKENS[0]!.id);
  const [threshold, setThreshold] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payments = s.wallet?.payments() ?? [];
  // a ?deal= link preselects that deal's payment until another is picked
  const fromLink = payments.findIndex((p) => p.dealId === params.get("deal"));
  const chosen = pick ?? (fromLink >= 0 ? fromLink : 0);
  const payment = payments[chosen];
  const dealLegs = payments.filter((p) => p.kind === "deal" && p.token === token).slice(0, 16);
  const volumeTotal = dealLegs.reduce((t, p) => t + p.made.amount, 0n);
  const min = what === "atleast" && payment ? parseAmount(payment.token, minInput) : null;
  const thr = parseAmount(token, threshold);
  const held = s.balances.get(token) ?? 0n;
  const readerOk = READER.test(reader.trim()) && reader.trim().length >= 2 && reader.trim().length <= 64;

  const ready =
    readerOk &&
    !busy &&
    (what === "exact" ? Boolean(payment) : what === "atleast" ? Boolean(payment) && min !== null && min <= payment!.made.amount : what === "funds" ? thr !== null && thr <= held : dealLegs.length > 0);

  const make = async () => {
    if (!s.identity || !s.wallet) return;
    setBusy(true);
    setError(null);
    setOut(null);
    setCopied(false);
    try {
      const scope = { net: NETWORK, reader: reader.trim(), expiresAtMs: expiryIn(Number(days)) };
      const src = artifactsAt(CIRCUITS_BASE);
      let proof;
      if (what === "exact" || what === "atleast") {
        const p = payment!;
        proof = await proveReceipt(src, s.identity, { ...scope, label: paymentLabel(p) }, p.made, p.paidWith, {
          revealAmount: what === "exact",
          ...(what === "atleast" ? { minAmount: min! } : {}),
          showPayee,
        });
      } else if (what === "funds") {
        await s.sync();
        const notes = s.wallet.spendable(token).sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, 4);
        if (notes.reduce((t, n) => t + n.amount, 0n) < thr!) throw new Error("Your four largest notes do not reach this amount; merge notes by sending to yourself first");
        proof = await proveFunds(src, s.identity, { ...scope, label: `Holds at least ${threshold} ${symbol(token)}` }, s.wallet.merkleTree, notes, thr!);
      } else {
        proof = await proveVolume(src, s.identity, { ...scope, label: `Desk volume in ${symbol(token)}` }, dealLegs.map((p) => ({ made: p.made, paidWith: p.paidWith })));
      }
      setOut(encodeProof(proof));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (s.status !== "ready") return <SignInPanel />;

  const link = out ? `${location.origin}/verify#p=${out}` : "";
  return (
    <div className="grid max-w-[620px] gap-5">
      <Field label="What to prove">
        <Segmented label="What to prove" value={what} onChange={(v) => { setWhat(v); setOut(null); }} options={WHATS} />
      </Field>

      {(what === "exact" || what === "atleast") &&
        (payments.length === 0 ? (
          <p className="text-[14px] text-mute">No payments yet. Proofs cover private sends and desk deals made from this browser.</p>
        ) : (
          <>
            <Field label="Which payment">
              <Select
                label="Payment"
                value={chosen}
                onChange={setPick}
                options={payments.map((p, i) => ({ value: i, label: paymentLabel(p), description: when(p.atMs) }))}
                className="w-full"
              />
            </Field>
            {what === "atleast" && payment && (
              <Field label={`Show that it was at least, in ${symbol(payment.token)}`} hint={min !== null && min > payment.made.amount ? "More than the payment." : "The exact amount stays hidden."}>
                <input className="hd-input tnum w-full" inputMode="decimal" placeholder="0" value={minInput} onChange={(e) => setMinInput(e.target.value.replace(/[^\d.,]/g, ""))} />
              </Field>
            )}
            <label className="flex items-center gap-2.5 text-[14px] text-soft">
              <input type="checkbox" checked={showPayee} onChange={(e) => setShowPayee(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />
              Also show who was paid (their receive key)
            </label>
          </>
        ))}

      {what === "funds" && (
        <AmountCard label="Show that you hold at least" value={threshold} onChange={setThreshold} token={token} onToken={setToken} balances={s.balances} note={`Private balance: ${fmt(token, held)} ${symbol(token)}. The proof shows the threshold, never the balance.`} />
      )}

      {what === "volume" && (
        <div className="grid gap-3">
          <Field label="Token">
            <TokenSelect value={token} onChange={setToken} balances={s.balances} />
          </Field>
          <p className="text-[13.5px] text-soft">
            {dealLegs.length > 0
              ? `Proves you delivered ${fmt(token, volumeTotal)} ${symbol(token)} across ${dealLegs.length} desk deal${dealLegs.length > 1 ? "s" : ""}, without saying which.`
              : `No desk deals in ${symbol(token)} from this browser yet.`}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <Field label="Who may read it" hint={reader && !readerOk ? "A NEAR account, like auditor.testnet." : "The proof names this NEAR account; anyone else checking it is told it is not theirs."}>
          <input className="hd-input w-full" placeholder="auditor.testnet" value={reader} onChange={(e) => setReader(e.target.value.toLowerCase())} spellCheck={false} autoCapitalize="none" />
        </Field>
        <Field label="Valid for">
          <Segmented label="Valid for" value={days} onChange={setDays} options={EXPIRY} />
        </Field>
      </div>

      <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!ready} onClick={make} aria-busy={busy}>
        <BusyLabel busy={busy} busyText="Proving in your browser…">
          Make the proof
        </BusyLabel>
      </button>
      <ErrorLine error={error} />

      {out && (
        <div className="hd-card grid gap-3 p-5 sm:p-6">
          <p className="t-label">Proof for {reader.trim()}</p>
          <p className="text-[13.5px] text-soft">Send this link. It opens the checker with the proof in the part of the address that never reaches a server.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-ink btn-sm" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
              {copied ? "Link copied" : "Copy the link"}
            </button>
            <a href={link} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              Check it yourself
            </a>
          </div>
          <details className="text-[12.5px] text-mute">
            <summary className="cursor-pointer select-none">Raw proof ({out.length.toLocaleString()} characters)</summary>
            <p className="mt-2 max-h-40 overflow-auto break-all font-mono">{out}</p>
          </details>
        </div>
      )}
    </div>
  );
}

export default function ProvePage() {
  return (
    <AppShell title="Prove" subtitle="Show one reader exactly what they need, and nothing else: a payment, a balance above a line, or your desk volume. Each proof names its reader and expires.">
      <Suspense>
        <ProveInner />
      </Suspense>
    </AppShell>
  );
}
