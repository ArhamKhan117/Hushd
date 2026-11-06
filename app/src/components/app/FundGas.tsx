"use client";

import { accountBalance } from "@hushd/sdk";
import { useEffect, useState, type ReactNode } from "react";
import { CopyButton } from "@/components/ui/CodeBlock";
import { Spinner } from "@/components/ui/Spinner";
import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";
import { useHushd } from "@/lib/hushd/session";

type Gas = "checking" | "empty" | "ready";

/**
 * Off testnet, a new passkey account (an implicit account) exists on chain only once
 * someone sends it NEAR, and no relayer does that for it. Until it holds NEAR for its own
 * gas, this shows its account id and re-reads its balance; then it shows `children`.
 * Wallet accounts, and every account on testnet, go straight through.
 */
export function FundGas({ children }: { children: ReactNode }) {
  const s = useHushd();
  const account = !IS_TESTNET && s.kind === "passkey" ? s.accountId : null;
  const [gas, setGas] = useState<{ account: string; gas: Gas } | null>(null);
  const current: Gas = !account ? "ready" : gas?.account === account ? gas.gas : "checking";

  useEffect(() => {
    if (!account) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shown: Gas = "checking";
    const check = async () => {
      try {
        const balance = await accountBalance(NETWORK, account);
        shown = balance !== null && balance > 0n ? "ready" : "empty";
      } catch {
        // the RPC did not answer: keep waiting if we were, otherwise let the page try
        if (shown === "checking") shown = "ready";
      }
      if (!live) return;
      setGas({ account, gas: shown });
      if (shown === "empty") timer = setTimeout(check, 4_000);
    };
    void check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [account]);

  if (current === "ready") return <>{children}</>;
  if (current === "checking") {
    return (
      <div className="hd-panel flex items-center gap-3 p-6 text-[14px] text-mute">
        <Spinner /> Checking your NEAR account…
      </div>
    );
  }
  return (
    <div className="hd-panel p-6 sm:p-8" role="region" aria-label="Add NEAR for gas">
      <p className="t-label">Passkey account</p>
      <h2 className="t-title mt-2">Add a little NEAR for gas</h2>
      <p className="mt-2 max-w-[56ch] text-[14.5px] leading-relaxed text-mute">
        Your passkey account is new and holds no NEAR yet. Send about 0.1 NEAR to it from any wallet or exchange to pay for its gas. This page moves on by itself once the NEAR arrives.
      </p>
      <div className="hd-card mt-5 flex max-w-[560px] flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-[12.5px] text-mute">Your NEAR account</p>
          <p className="mt-1 break-all text-[14px] leading-relaxed text-foreground">{account}</p>
        </div>
        <CopyButton text={account!} label="Copy account id" className="-ml-2.5 self-start sm:ml-0 sm:self-center" />
      </div>
      <p className="mt-4 flex items-center gap-2 text-[13px] text-mute" aria-live="polite">
        <Spinner /> Waiting for NEAR to arrive…
      </p>
    </div>
  );
}
