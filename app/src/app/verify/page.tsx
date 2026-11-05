"use client";

import { decodeProof, verifyProof, type ReaderProof, type Verdict } from "@hushd/sdk";
import { useCallback, useEffect, useState } from "react";
import { Header } from "@/components/Header";
import { ErrorLine, Field } from "@/components/app/forms";
import { BusyLabel } from "@/components/ui/Spinner";
import { CIRCUITS_BASE, NETWORK } from "@/lib/hushd/config";
import { fmt, symbol, TOKENS } from "@/lib/hushd/format";

const KIND_WORDS = { receipt: "Payment", funds: "Funds held", volume: "Desk volume" } as const;

/** Base units to a readable amount when the token is one we list. */
function amountWords(p: ReaderProof, line: string) {
  if (!TOKENS.some((t) => t.id === p.token)) return line;
  return line.replace(/(\d+) \(base units\)/, (_m, n: string) => `${fmt(p.token, BigInt(n))} ${symbol(p.token)}`);
}

export default function VerifyPage() {
  const [input, setInput] = useState("");
  const [me, setMe] = useState("");
  const [proof, setProof] = useState<ReaderProof | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async (raw: string, asReader: string) => {
    setBusy(true);
    setError(null);
    setVerdict(null);
    try {
      const p = decodeProof(raw);
      setProof(p);
      const vkey = await (await fetch(`${CIRCUITS_BASE}/${p.kind}.vkey.json`)).json();
      setVerdict(await verifyProof(NETWORK, p, vkey, asReader ? { asReader } : {}));
    } catch (e) {
      setProof(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const p = new URLSearchParams(location.hash.slice(1)).get("p");
    if (!p) return;
    setInput(p);
    try {
      const d = decodeProof(p);
      setMe(d.reader);
      void check(p, d.reader);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [check]);

  return (
    <div className="relative flex min-h-screen flex-col bg-panel text-foreground">
      <Header />
      <main id="main" className="mx-auto grid w-full max-w-[760px] gap-6 px-5 pb-20 pt-10 sm:pt-16">
        <div>
          <p className="t-label">Proof checker</p>
          <h1 className="t-display-m mt-3">Check a Hushd proof</h1>
          <p className="mt-4 max-w-[58ch] text-[15.5px] leading-relaxed text-soft">
            A proof shows one fact about private money (a payment, a balance above a line, or desk volume) to one named NEAR account, until it expires. This page checks the zero-knowledge proof in your browser, then asks the pool contract on NEAR to check it again against the chain.
          </p>
        </div>

        <Field label="Proof">
          <textarea
            className="hd-input min-h-[120px] w-full resize-y py-3 font-mono text-[12.5px]"
            placeholder="hushdproof1…"
            value={input}
            onChange={(e) => setInput(e.target.value.trim())}
            spellCheck={false}
          />
        </Field>
        <Field label="You are (NEAR account)" hint="A proof made for someone else is shown as such, never quietly accepted.">
          <input className="hd-input w-full" placeholder="auditor.testnet" value={me} onChange={(e) => setMe(e.target.value.toLowerCase())} spellCheck={false} autoCapitalize="none" />
        </Field>
        <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!input || busy} onClick={() => void check(input, me.trim())} aria-busy={busy}>
          <BusyLabel busy={busy} busyText="Checking in your browser and on chain…">
            Check
          </BusyLabel>
        </button>
        <ErrorLine error={error} />

        {proof && verdict && (
          <section className={`hd-card grid gap-4 p-5 sm:p-6 ${verdict.ok ? "" : "border-danger/40"}`} aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="t-label">{KIND_WORDS[proof.kind]}</p>
              <span className={`rounded-full px-3 py-1 text-[12.5px] font-medium ${verdict.ok ? "bg-accent-soft text-accent" : "bg-danger-soft text-danger"}`}>{verdict.ok ? "Holds" : "Does not hold"}</span>
            </div>
            {verdict.ok ? (
              <ul className="grid gap-1.5">
                {verdict.shows.map((line) => (
                  <li key={line} className="text-[16px] text-foreground">
                    {amountWords(proof, line)}
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="grid gap-1.5">
                {verdict.problems.map((line) => (
                  <li key={line} className="text-[14.5px] text-danger">
                    {line}
                  </li>
                ))}
              </ul>
            )}
            <dl className="grid gap-1 border-t border-line pt-4 text-[13px] text-mute">
              <div>
                <dt className="inline">Made for: </dt>
                <dd className="inline text-soft">{proof.reader}</dd>
              </div>
              <div>
                <dt className="inline">Expires: </dt>
                <dd className="inline text-soft">{new Date(proof.expiresAtMs).toLocaleString("en-GB")}</dd>
              </div>
              <div>
                <dt className="inline">Pool: </dt>
                <dd className="inline text-soft">
                  {proof.pool} on NEAR {proof.network}
                </dd>
              </div>
              {proof.label && (
                <div>
                  <dt className="inline">The prover&apos;s label (not proven): </dt>
                  <dd className="inline text-soft">{proof.label}</dd>
                </div>
              )}
              {verdict.chain && (
                <div>
                  <dt className="inline">Pool contract: </dt>
                  <dd className="inline text-soft">{verdict.chain.proof_valid ? "accepts the proof against the chain" : "refuses the proof"}</dd>
                </div>
              )}
            </dl>
          </section>
        )}
      </main>
    </div>
  );
}
