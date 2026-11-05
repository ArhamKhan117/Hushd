"use client";

import { useEffect, useRef, useState } from "react";
import { useHushd } from "@/lib/hushd/session";

const short = (s: string) => (s.length > 20 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s);

/** Who is signed in, the receive address, and sign out. */
export function WalletMenu({ compact }: { compact?: boolean }) {
  const s = useHushd();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (s.status === "loading") return <div className="hd-skeleton h-10 w-full rounded-xl" aria-hidden />;
  if (s.status === "signed-out") {
    return (
      <button type="button" className={`btn btn-ink btn-sm ${compact ? "" : "btn-block"}`} onClick={() => void s.connectWallet().catch(() => undefined)}>
        Sign in
      </button>
    );
  }

  const copy = async () => {
    if (!s.identity) return;
    await navigator.clipboard.writeText(s.identity.address).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`flex items-center gap-2 rounded-xl text-left transition-colors hover:bg-surface ${compact ? "h-10 px-2.5" : "h-11 w-full px-2.5"}`}
      >
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${s.status === "ready" ? "bg-accent" : "bg-line-strong"}`} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-foreground">{short(s.accountId ?? "")}</span>
          {!compact && <span className="block text-[12px] text-mute">{s.status === "ready" ? (s.syncing ? "Syncing…" : "Private balance open") : "Locked"}</span>}
        </span>
      </button>
      {open && (
        <div className="hd-pop absolute bottom-full right-0 z-50 mb-2 w-[280px] rounded-2xl border border-line bg-panel p-2 shadow-pop max-lg:bottom-auto max-lg:top-full max-lg:mb-0 max-lg:mt-2">
          <p className="px-3 pb-1 pt-2 text-[12px] text-mute">{s.kind === "passkey" ? "Passkey account" : "NEAR wallet"}</p>
          <p className="break-all px-3 pb-2 text-[13px] text-foreground">{s.accountId}</p>
          {s.identity && (
            <button type="button" onClick={copy} className="flex w-full flex-col rounded-xl px-3 py-2 text-left hover:bg-surface">
              <span className="text-[13px] text-foreground">{copied ? "Copied" : "Copy receive address"}</span>
              <span className="truncate text-[12px] text-mute">{s.identity.address}</span>
            </button>
          )}
          {s.status === "ready" && (
            <button type="button" onClick={() => void s.sync()} className="w-full rounded-xl px-3 py-2 text-left text-[13px] hover:bg-surface">
              {s.syncing ? "Syncing…" : "Sync now"}
            </button>
          )}
          <button type="button" onClick={() => void s.signOut()} className="w-full rounded-xl px-3 py-2 text-left text-[13px] text-danger hover:bg-surface">
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
