"use client";

import { useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { AmountCard, ErrorLine, Field, TxLine } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { BusyLabel } from "@/components/ui/Spinner";
import { fmt, parseAmount, symbol, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

const isAccount = (s: string) => /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s) && s.length >= 2 && s.length <= 64;

export default function CashOutPage() {
  const s = useHushd();
  // the recipient defaults to your own account until you type another
  const [typedTo, setTo] = useState<string | null>(null);
  const to = typedTo ?? s.accountId ?? "";
  const [token, setToken] = useState(TOKENS[0]!.id);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amount = parseAmount(token, input);
  const have = s.balances.get(token) ?? 0n;

  const go = async () => {
    if (!s.wallet || amount === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await s.wallet.cashOut(to.trim(), token, amount);
      setDone({ hash: r.txHash, text: `${fmt(token, amount)} ${symbol(token)} is on its way to ${to}.` });
      setInput("");
      void s.sync();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="Cash out" subtitle="Move tokens from your private balance to any NEAR account. The amount and the account are public on the way out; which notes paid for it is not.">
      {s.status !== "ready" ? (
        <SignInPanel />
      ) : (
        <div className="grid max-w-[560px] gap-4">
          <AmountCard label="Amount" value={input} onChange={setInput} token={token} onToken={setToken} balances={s.balances} note={`Private balance: ${fmt(token, have)} ${symbol(token)}`} />
          <Field label="To NEAR account" hint="A fresh account keeps this cash out apart from your others. The account must be registered with the token; if the payout fails, the amount comes back to you as a private note.">
            <input className="hd-input w-full" value={to} onChange={(e) => setTo(e.target.value.trim().toLowerCase())} spellCheck={false} />
          </Field>
          <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!isAccount(to) || amount === null || amount > have || busy} onClick={go} aria-busy={busy}>
            <BusyLabel busy={busy} busyText="Proving and sending…">{amount !== null && amount > have ? "More than your private balance" : "Cash out"}</BusyLabel>
          </button>
          {done && <TxLine hash={done.hash}>{done.text}</TxLine>}
          <ErrorLine error={error} />
        </div>
      )}
    </AppShell>
  );
}
