"use client";

import { accountUrl, deskView, type MakerView } from "@hushd/sdk";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { NETWORK } from "@/lib/hushd/config";
import { StateDot } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";

const BOND = NETWORK.bondToken ?? NETWORK.tokens[0]!.id;

const STYLE_WORDS: Record<string, string> = {
  fixed: "Fixed spread: 25 bps on every quote",
  volatility: "Prices the last hour's volatility into the spread",
  inventory: "Tighter when it holds plenty of what you buy, wider when it runs low",
};

const short = (h: string | null) => (h ? `${h.slice(0, 12)}…${h.slice(-6)}` : "not set yet");

export default function MakersPage() {
  const [makers, setMakers] = useState<[string, MakerView][] | null>(null);
  const [enclave, setEnclave] = useState<{ sign_key: string | null; enc_key: string | null; project: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([deskView.makers(NETWORK), deskView.enclave(NETWORK)])
      .then(([m, e]) => {
        setMakers(m);
        setEnclave(e);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <AppShell title="Makers" subtitle="The agents that quote on the desk. Each one posts a bond on chain and signs every quote with a key the desk checks; a missed hedge costs it the bond.">
      <div className="grid gap-6">
        {error && <p className="text-[13.5px] text-danger">Could not read the desk: {error}</p>}
        {!makers && !error && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="hd-skeleton h-56" />
            ))}
          </div>
        )}
        {makers && makers.length === 0 && <p className="text-[14px] text-mute">No makers are registered yet.</p>}
        {makers && makers.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {makers.map(([acc, m]) => (
              <li key={acc} className="hd-card grid content-start gap-3 p-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[17px] font-medium text-foreground">{m.name}</p>
                  <span className="flex items-center gap-2 text-[12.5px] text-mute">
                    <StateDot tone={m.active ? "ok" : "wait"} />
                    {m.active ? "Quoting" : "Paused"}
                  </span>
                </div>
                <p className="text-[13px] leading-relaxed text-soft">{STYLE_WORDS[m.style] ?? m.style}</p>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-[13px]">
                  <div>
                    <dt className="text-mute">Bond</dt>
                    <dd className="tnum text-foreground">
                      {fmt(BOND, BigInt(m.bond))} {symbol(BOND)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mute">Locked in deals</dt>
                    <dd className="tnum text-foreground">{fmt(BOND, BigInt(m.locked))}</dd>
                  </div>
                  <div>
                    <dt className="text-mute">Deals</dt>
                    <dd className="tnum text-foreground">{m.deals}</dd>
                  </div>
                  <div>
                    <dt className="text-mute">Slashed</dt>
                    <dd className="tnum text-foreground">{fmt(BOND, BigInt(m.slashed))}</dd>
                  </div>
                </dl>
                <a href={accountUrl(NETWORK, acc)} target="_blank" rel="noreferrer" className="break-all text-[12.5px] text-mute underline decoration-line-strong underline-offset-4 hover:text-foreground">
                  {acc}
                </a>
              </li>
            ))}
          </ul>
        )}

        {enclave && (
          <section className="hd-tile grid gap-2 p-5 sm:p-6">
            <p className="t-label">The matcher</p>
            <p className="text-[14px] leading-relaxed text-soft">
              Requests and quotes are opened only inside a TEE: the matcher runs as the OutLayer project <span className="text-foreground">{enclave.project}</span>, with keys generated inside the enclave. The desk accepts a match only from OutLayer&apos;s on-chain callback or signed by this enclave key.
            </p>
            <p className="break-all text-[12.5px] text-mute">Signing key {short(enclave.sign_key)} · Sealing key {short(enclave.enc_key)}</p>
          </section>
        )}

        <section className="grid gap-2">
          <p className="t-label">Run your own maker</p>
          <p className="max-w-[64ch] text-[14px] leading-relaxed text-soft">
            A maker is an agent with a NEAR account, a quote key and a bond. It reads the asks sealed to it, prices them (Hyperliquid mids and NEAR Intents quotes for reference), seals a signed quote to the enclave and settles its leg in the pool. The reference makers in this repo are a starting point:{" "}
            <a href="/docs/makers" className="text-foreground underline decoration-line-strong underline-offset-4">
              maker guide
            </a>
            .
          </p>
        </section>
      </div>
    </AppShell>
  );
}
