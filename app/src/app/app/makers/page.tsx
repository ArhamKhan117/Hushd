"use client";

import { accountUrl, custodyView, deskView, readLimit, readMakerRecords, type MakerRecord, type MakerView } from "@hushd/sdk";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { NETWORK } from "@/lib/hushd/config";
import { StateDot } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";
import { lapsePercent, RECORD_RULE, recordStanding } from "@/lib/hushd/record";

const BOND = NETWORK.bondToken ?? NETWORK.tokens[0]!.id;
/** Anyone can register as a maker: read their policy wallets two at a time, not all at once. */
const read = readLimit(2);

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
  // the owner of each maker's policy wallet, read on chain (an implicit account is its wallet key)
  const [wallets, setWallets] = useState<Record<string, { owner: string; frozen: boolean }>>({});
  // each maker's record, counted from the desk's own deals: what a request checks before it asks
  const [records, setRecords] = useState<Map<string, MakerRecord> | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([deskView.makers(NETWORK), deskView.enclave(NETWORK)])
      .then(([m, e]) => {
        setMakers(m);
        setEnclave(e);
        return Promise.all(
          m.filter(([acc]) => /^[0-9a-f]{64}$/.test(acc)).map(async ([acc]) => ({ acc, policy: await read(() => custodyView.policy(NETWORK, `ed25519:${acc}`)).catch(() => null) })),
        );
      })
      .then((found) => setWallets(Object.fromEntries(found.flatMap(({ acc, policy }) => (policy ? [[acc, policy]] : [])))))
      .catch((e: Error) => setError(e.message));
    read(() => readMakerRecords(NETWORK)).then(
      (r) => setRecords(r.records),
      (e: Error) => setRecordError(e.message),
    );
  }, []);

  // a paused desk account with no bond belongs to a maker that quotes from a policy wallet: list those apart
  const retired = makers?.filter(([, m]) => !m.active && BigInt(m.bond) === 0n) ?? [];
  const current = makers?.filter((x) => !retired.includes(x)) ?? null;

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
        {current && current.length === 0 && <p className="text-[14px] text-mute">No makers are registered yet.</p>}
        {current && current.length > 0 && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {current.map(([acc, m]) => (
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
                <TrackRecord record={records?.get(acc)} loading={!records && !recordError} failed={recordError} />
                <p className="flex items-start gap-2 border-t border-line pt-3 text-[13px] leading-relaxed text-soft">
                  {wallets[acc] ? (
                    <>
                      {/* centred on the first line of text, and never squeezed by it */}
                      <span className="flex h-[1lh] shrink-0 items-center">
                        <StateDot tone={wallets[acc]!.frozen ? "wait" : "ok"} />
                      </span>
                      <span>
                        Signs through a policy wallet: its key stays in OutLayer&apos;s TEE, which allows only calls to Hushd&apos;s contracts. Owner <span className="text-foreground">{wallets[acc]!.owner}</span>
                        {wallets[acc]!.frozen ? ", frozen" : ""}.
                      </span>
                    </>
                  ) : (
                    <span>Signs with its own key.</span>
                  )}
                </p>
                <a href={accountUrl(NETWORK, acc)} target="_blank" rel="noreferrer" className="break-all text-[12.5px] text-mute underline decoration-line-strong underline-offset-4 hover:text-foreground">
                  {acc}
                </a>
              </li>
            ))}
          </ul>
        )}

        {current && current.length > 0 && <p className="max-w-[64ch] text-[13.5px] leading-relaxed text-soft">{RECORD_RULE}</p>}

        {retired.length > 0 && (
          <section className="grid gap-2">
            <p className="t-label">Paused accounts</p>
            <p className="max-w-[64ch] text-[14px] leading-relaxed text-soft">These desk accounts are paused and hold no bond: their makers quote from policy wallets instead. Their deals stay on record.</p>
            <ul className="grid gap-1.5 text-[13px]">
              {retired.map(([acc, m]) => (
                <li key={acc} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <span className="text-foreground">{m.name}</span>
                  <a href={accountUrl(NETWORK, acc)} target="_blank" rel="noreferrer" className="text-mute underline decoration-line-strong underline-offset-4 hover:text-foreground">
                    {acc}
                  </a>
                  <span className="tnum text-mute">
                    {m.deals} {m.deals === 1 ? "deal" : "deals"}
                    {BigInt(m.slashed) > 0n ? `, ${fmt(BOND, BigInt(m.slashed))} ${symbol(BOND)} slashed` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {enclave && (
          <section className="grid gap-2">
            <p className="t-label">The matcher</p>
            <p className="max-w-[64ch] text-[14px] leading-relaxed text-soft">
              Requests and quotes are opened only inside a TEE: the matcher runs as the OutLayer project <span className="text-foreground">{enclave.project.split("@")[0]}</span>
              {enclave.project.includes("@") && (
                <>
                  {" "}
                  (pinned to build <span className="font-mono text-foreground">{enclave.project.split("@")[1]!.slice(0, 12)}…</span>, changed only after the desk&apos;s timelock)
                </>
              )}
              , with keys generated inside the enclave. The desk accepts a match only from OutLayer&apos;s on-chain callback or signed by this enclave key.
            </p>
            <p className="break-all text-[12.5px] text-mute">Signing key {short(enclave.sign_key)} · Sealing key {short(enclave.enc_key)}</p>
          </section>
        )}

        <section className="grid gap-2">
          <p className="t-label">Run your own maker</p>
          <p className="max-w-[64ch] text-[14px] leading-relaxed text-soft">
            A maker is an agent with a NEAR account (best a policy wallet, so it never holds a NEAR key), a quote key and a bond. It reads the asks sealed to it, prices them (Hyperliquid mids and NEAR Intents quotes for reference), seals a signed quote to the enclave and settles its leg in the pool. The reference makers in this repo are a starting point:{" "}
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

/** A maker's recent record: settled, lapsed and the lapse rate, and whether requests ask it. */
function TrackRecord({ record, loading, failed }: { record: MakerRecord | undefined; loading: boolean; failed: string | null }) {
  if (loading) return <div className="hd-skeleton h-[60px]" aria-label="Reading its record" />;
  if (failed)
    return (
      <p className="border-t border-line pt-3 text-[13px] text-mute" title={failed}>
        Its record could not be read just now.
      </p>
    );
  const standing = recordStanding(record);
  return (
    <div className="grid gap-2 border-t border-line pt-3 text-[13px]" data-record>
      {record && record.ended > 0 && (
        <dl className="grid grid-cols-3 gap-x-4">
          <div>
            <dt className="text-mute">Settled</dt>
            <dd className="tnum text-foreground">{record.settled}</dd>
          </div>
          <div>
            <dt className="text-mute">Lapsed</dt>
            <dd className="tnum text-foreground">{record.lapsed}</dd>
          </div>
          <div>
            <dt className="text-mute">Lapse rate</dt>
            <dd className="tnum text-foreground">{lapsePercent(record)}</dd>
          </div>
        </dl>
      )}
      <p className="flex items-start gap-2 leading-relaxed text-soft">
        <span className="flex h-[1lh] shrink-0 items-center">
          <StateDot tone={standing.tone} />
        </span>
        <span>
          {record && record.ended > 0 ? `Last ${record.ended} ended ${record.ended === 1 ? "deal" : "deals"}. ` : ""}
          {standing.words}.
        </span>
      </p>
    </div>
  );
}
