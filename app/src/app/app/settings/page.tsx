"use client";

import { accountUrl, type RelayerInfo } from "@hushd/sdk";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { ThemeSegmented } from "@/components/ThemeToggle";
import { NETWORK } from "@/lib/hushd/config";
import { useHushd } from "@/lib/hushd/session";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3.5 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-[13px] text-mute">{label}</dt>
      <dd className="min-w-0 break-words text-[14px] text-foreground">{children}</dd>
    </div>
  );
}

export default function SettingsPage() {
  const s = useHushd();
  const [relayer, setRelayer] = useState<RelayerInfo | null>(null);
  useEffect(() => {
    s.relayer.info().then(setRelayer, () => setRelayer(null));
  }, [s.relayer]);

  return (
    <AppShell title="Settings" subtitle="Where this app runs and who you are on it.">
      <div className="grid max-w-[760px] gap-6">
        <div className="hd-card px-5 sm:px-6">
          <dl className="divide-y divide-line">
            <Row label="Signed in">
              {s.accountId ? (
                <a href={accountUrl(NETWORK, s.accountId)} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                  {s.accountId}
                </a>
              ) : (
                "Not signed in"
              )}
              {s.kind && <span className="block text-[12.5px] text-mute">{s.kind === "passkey" ? "Passkey account: its key comes from your passkey and never leaves this device" : "NEAR wallet through NEAR Connect"}</span>}
            </Row>
            {s.identity && (
              <Row label="Receive address">
                <span className="break-all">{s.identity.address}</span>
                <span className="block text-[12.5px] text-mute">Derived from a signature only you can make. Your notes are kept in this browser, encrypted, and on the board sealed to you, so a new device recovers them.</span>
              </Row>
            )}
            <Row label="Network">NEAR {NETWORK.id}</Row>
            <Row label="Contracts">
              <span className="block">Pool {NETWORK.pool}</span>
              <span className="block">Desk {NETWORK.desk}</span>
              <span className="block">Board {NETWORK.board}</span>
            </Row>
            <Row label="Relayer">
              {relayer ? (
                <>
                  {relayer.account}
                  <span className="block text-[12.5px] text-mute">
                    Sends your proven actions from its own account. Cash-out fee {relayer.cashOutFeeBps / 100}%. It can refuse to send, never change what you proved.
                  </span>
                </>
              ) : (
                <span className="text-mute">Unreachable at {NETWORK.api}</span>
              )}
            </Row>
            <Row label="Theme">
              <ThemeSegmented />
            </Row>
          </dl>
        </div>
        {s.status === "ready" && (
          <button type="button" className="btn btn-ghost w-fit" onClick={() => void s.signOut()}>
            Sign out
          </button>
        )}
      </div>
    </AppShell>
  );
}
