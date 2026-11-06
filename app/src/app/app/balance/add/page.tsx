"use client";

import { view } from "@hushd/sdk";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Segmented } from "@/components/app/desk";
import { AmountCard, ErrorLine, TxLine } from "@/components/app/forms";
import { OtherChainPreview } from "@/components/app/intents";
import { SignInPanel } from "@/components/app/SignInPanel";
import { BusyLabel } from "@/components/ui/Spinner";
import { NETWORK } from "@/lib/hushd/config";
import { fmt, parseAmount, symbol, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

export default function AddPage() {
  const s = useHushd();
  const [from, setFrom] = useState<"near" | "chain">("near");
  const [token, setToken] = useState(TOKENS[0]!.id);
  const [input, setInput] = useState("");
  const [publicBal, setPublicBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<"faucet" | "add" | null>(null);
  const [done, setDone] = useState<{ hash: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readBalance = useCallback(async () => {
    if (!s.accountId) return null;
    return BigInt(await view<string>(NETWORK, token, "ft_balance_of", { account_id: s.accountId }).catch(() => "0"));
  }, [s.accountId, token]);
  const refresh = useCallback(async () => {
    const b = await readBalance();
    if (b !== null) setPublicBal(b);
  }, [readBalance]);
  useEffect(() => {
    let live = true;
    readBalance().then((b) => live && b !== null && setPublicBal(b));
    return () => {
      live = false;
    };
  }, [readBalance]);

  const amount = parseAmount(token, input);
  const tooMuch = amount !== null && publicBal !== null && amount > publicBal;

  const faucet = async () => {
    setBusy("faucet");
    setError(null);
    try {
      const r = s.kind === "passkey" ? await s.relayer.faucet(s.accountId!, token) : await s.call({ contract: token, method: "faucet", args: {}, gas: "30000000000000" });
      setDone({ hash: r.txHash, text: `Test ${symbol(token)} sent to ${s.accountId}.` });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    if (!s.wallet || amount === null) return;
    setBusy("add");
    setError(null);
    try {
      const { call, selfPost } = s.wallet.shield(token, amount);
      // The note goes on the board, sealed to you, before any token moves: the deposit is then
      // recoverable from your seed alone, even if this tab closes mid-way.
      await s.relayer.post(selfPost, "note");
      const r = await s.call({ contract: call.contract, method: call.method, args: call.args, gas: call.gas, deposit: call.deposit });
      setDone({ hash: r.txHash, text: `${fmt(token, amount)} ${symbol(token)} is now private.` });
      setInput("");
      await Promise.all([refresh(), s.sync()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell
      title="Add privately"
      subtitle={
        from === "near"
          ? "Move tokens from your NEAR account into the pool. The deposit is public; what you do with it afterwards is not."
          : "See what a deposit from another chain would bring into your private balance, with a live NEAR Intents quote from mainnet."
      }
    >
      <div className="grid gap-5">
        <Segmented
          label="Add from"
          value={from}
          onChange={setFrom}
          options={[
            { value: "near", label: "From NEAR" },
            { value: "chain", label: "From another chain" },
          ]}
        />
        {from === "chain" ? (
          <div className="max-w-[560px]">
            <OtherChainPreview direction="deposit" />
          </div>
        ) : s.status !== "ready" ? (
          <SignInPanel />
        ) : (
          <div className="grid max-w-[560px] gap-4">
            <AmountCard
              label="Amount to add"
              value={input}
              onChange={setInput}
              token={token}
              onToken={(t) => {
                setToken(t);
                setInput("");
              }}
              note={
                <span className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    In {s.accountId}: {publicBal === null ? "…" : `${fmt(token, publicBal)} ${symbol(token)}`}
                    {publicBal !== null && publicBal > 0n && (
                      <button type="button" className="ml-2 text-foreground underline underline-offset-4" onClick={() => setInput(fmt(token, publicBal, 24).replace(/,/g, ""))}>
                        Max
                      </button>
                    )}
                  </span>
                  <button type="button" className="text-foreground underline decoration-line-strong underline-offset-4" onClick={faucet} disabled={busy !== null}>
                    <BusyLabel busy={busy === "faucet"} busyText="Getting test tokens…">Get test {symbol(token)}</BusyLabel>
                  </button>
                </span>
              }
            />
            <button type="button" className="btn btn-ink btn-lg btn-block" disabled={amount === null || tooMuch || busy !== null} onClick={add} aria-busy={busy === "add"}>
              <BusyLabel busy={busy === "add"} busyText="Confirm in your wallet…">{tooMuch ? `Not that much ${symbol(token)} in your account` : "Add privately"}</BusyLabel>
            </button>
            {done && <TxLine hash={done.hash}>{done.text}</TxLine>}
            <ErrorLine error={error} />
            <p className="text-[13px] leading-relaxed text-mute">
              The pool computes your note from the tokens it actually receives, so a deposit can never claim more than it sends. Your NEAR account is visible on this
              deposit; spends, payments and deals after it are not linked to it.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}
