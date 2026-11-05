"use client";

import { isAddress } from "@hushd/sdk";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { AmountCard, ErrorLine, Field, TxLine } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { BusyLabel } from "@/components/ui/Spinner";
import { fmt, parseAmount, symbol, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

export default function SendPage() {
  const s = useHushd();
  const [to, setTo] = useState("");
  const [token, setToken] = useState(TOKENS[0]!.id);
  const [input, setInput] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState("");
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A payment request link fills the form: /app/balance/send#to=…&token=…&amount=…
  useEffect(() => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get("to")) setTo(p.get("to")!);
    if (p.get("token") && TOKENS.some((t) => t.id === p.get("token"))) setToken(p.get("token")!);
    if (p.get("amount")) setInput(p.get("amount")!);
    if (p.get("memo")) setMemo(p.get("memo")!);
  }, []);

  const amount = parseAmount(token, input);
  const have = s.balances.get(token) ?? 0n;
  const validTo = isAddress(to.trim());

  const send = async () => {
    if (!s.wallet || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      setStep("Proving in your browser…");
      const r = await s.wallet.send(to.trim(), token, amount, memo || undefined);
      setDone({ hash: r.txHash, text: `Sent ${fmt(token, amount)} ${symbol(token)} privately. The recipient finds it on the board; nobody else learns who or how much.` });
      setInput("");
      void s.sync();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setStep("");
    }
  };

  return (
    <AppShell title="Send privately" subtitle="Pay any Hushd address from your private balance. The relayer sends it, so your NEAR account never appears.">
      {s.status !== "ready" ? (
        <SignInPanel />
      ) : (
        <div className="grid max-w-[560px] gap-4">
          <Field label="To" hint={to && !validTo ? "That is not a Hushd address (hushd1…)." : "A hushd1… receive address."}>
            <input className="hd-input w-full" placeholder="hushd1…" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
          </Field>
          <AmountCard
            label="Amount"
            value={input}
            onChange={setInput}
            token={token}
            onToken={setToken}
            balances={s.balances}
            note={`Private balance: ${fmt(token, have)} ${symbol(token)}`}
          />
          <Field label="Note to the recipient (optional)" hint="Encrypted to them with the payment.">
            <input className="hd-input w-full" value={memo} maxLength={120} onChange={(e) => setMemo(e.target.value)} />
          </Field>
          <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!validTo || amount === null || amount > have || busy} onClick={send} aria-busy={busy}>
            <BusyLabel busy={busy} busyText={step || "Sending…"}>{amount !== null && amount > have ? "More than your private balance" : "Send privately"}</BusyLabel>
          </button>
          {done && <TxLine hash={done.hash}>{done.text}</TxLine>}
          <ErrorLine error={error} />
        </div>
      )}
    </AppShell>
  );
}
