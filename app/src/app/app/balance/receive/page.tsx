"use client";

import Image from "next/image";
import QRCode from "qrcode";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Field, TokenSelect } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { CopyButton } from "@/components/ui/CodeBlock";
import { parseAmount, TOKENS } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

export default function ReceivePage() {
  const s = useHushd();
  const [token, setToken] = useState(TOKENS[0]!.id);
  const [input, setInput] = useState("");
  const [memo, setMemo] = useState("");
  const [qr, setQr] = useState("");
  const address = s.identity?.address ?? "";

  const link = useMemo(() => {
    if (!address) return "";
    const p = new URLSearchParams({ to: address, token });
    if (parseAmount(token, input) !== null) p.set("amount", input);
    if (memo) p.set("memo", memo);
    return `${location.origin}/app/balance/send#${p.toString()}`;
  }, [address, token, input, memo]);

  useEffect(() => {
    if (!address) return;
    QRCode.toDataURL(address, { margin: 1, width: 320, color: { dark: "#0b0c0e", light: "#ffffff" } }).then(setQr).catch(() => setQr(""));
  }, [address]);

  return (
    <AppShell title="Receive" subtitle="Share your receive address, or a payment request link with the amount filled in. Payments to it land in your private balance.">
      {s.status !== "ready" ? (
        <SignInPanel />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="hd-panel p-5 sm:p-6">
            <p className="t-label">Your receive address</p>
            <p className="mt-3 break-all text-[15px] leading-relaxed text-foreground">{address}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <CopyButton text={address} />
            </div>
            <div className="mt-8 grid gap-4">
              <p className="t-label">Payment request</p>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Amount (optional)">
                  <input className="hd-input w-[180px]" inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value.replace(/[^\d.]/g, ""))} placeholder="0" />
                </Field>
                <TokenSelect value={token} onChange={setToken} />
              </div>
              <Field label="What it is for (optional)">
                <input className="hd-input w-full" value={memo} maxLength={120} onChange={(e) => setMemo(e.target.value)} />
              </Field>
              <div className="rounded-xl bg-surface p-3 text-[13px] text-soft">
                <p className="break-all">{link}</p>
                <div className="mt-2">
                  <CopyButton text={link} />
                </div>
              </div>
            </div>
          </div>
          <div className="hd-panel grid place-items-center p-6">
            {qr ? <Image src={qr} alt="QR code of your receive address" width={260} height={260} unoptimized className="rounded-xl" /> : <div className="hd-skeleton h-[260px] w-[260px] rounded-xl" />}
            <p className="mt-3 text-center text-[12.5px] text-mute">Scan to get the receive address.</p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
