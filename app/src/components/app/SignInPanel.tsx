"use client";

import { useHushd } from "@/lib/hushd/session";
import { passkeySupported } from "@/lib/hushd/keys";
import { Mark } from "@/components/Logo";
import { Spinner } from "@/components/ui/Spinner";
import { useState } from "react";

/**
 * What a page that needs the private balance shows until it is open: sign in with a
 * NEAR wallet or a passkey, then unlock (one signature, nothing stored).
 */
export function SignInPanel({ title = "Open your private balance" }: { title?: string }) {
  const s = useHushd();
  const [busy, setBusy] = useState<string | null>(null);
  const go = (k: string, f: () => Promise<void>) => async () => {
    setBusy(k);
    try {
      await f();
    } catch {
      /* the session shows the error */
    } finally {
      setBusy(null);
    }
  };

  if (s.status === "loading") {
    return (
      <div className="hd-panel flex items-center gap-3 p-6 text-[14px] text-mute">
        <Spinner /> Checking for a wallet…
      </div>
    );
  }

  return (
    <div className="hd-crop">
    <div className="hd-sheen relative overflow-hidden rounded-[20px] border border-line bg-panel p-6 sm:p-8">
      <Mark size={220} className="pointer-events-none absolute -right-10 -top-8 hidden opacity-[0.06] sm:block" />
      <div className="relative">
      <p className="t-label">Private balance</p>
      <h2 className="t-title mt-2">{title}</h2>
      {s.status === "connected" ? (
        <>
          <p className="mt-2 max-w-[56ch] text-[14.5px] leading-relaxed text-mute [overflow-wrap:anywhere]">
            {s.kind === "passkey"
              ? "Use your passkey to open the private balance on this device."
              : `Signed in as ${s.accountId}. Sign one message to open your private balance. It never leaves this device, moves no funds, and the same wallet key opens the same balance anywhere.`}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ink" onClick={go("unlock", s.unlock)} disabled={busy !== null} aria-busy={busy === "unlock"}>
              {busy === "unlock" ? <Spinner /> : null} {s.kind === "passkey" ? "Use passkey" : "Sign to open"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => void s.signOut()}>
              Sign out
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-2 max-w-[56ch] text-[14.5px] leading-relaxed text-mute">
            Sign in with a NEAR wallet (HOT, Meteor, Intear and others), or use a passkey on this device: no wallet, no seed phrase.
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ink" onClick={go("wallet", s.connectWallet)} disabled={busy !== null}>
              {busy === "wallet" ? <Spinner /> : null} Connect a NEAR wallet
            </button>
            {passkeySupported() && (
              <>
                <button type="button" className="btn btn-ghost" onClick={go("create", s.createPasskeyAccount)} disabled={busy !== null}>
                  {busy === "create" ? <Spinner /> : null} Create a passkey
                </button>
                <button type="button" className="btn btn-quiet" onClick={go("passkey", s.unlockWithPasskey)} disabled={busy !== null}>
                  I have a passkey
                </button>
              </>
            )}
          </div>
        </>
      )}
      {s.error && <p className="mt-4 text-[13.5px] text-danger" role="alert">{s.error}</p>}
      </div>
    </div>
    </div>
  );
}
