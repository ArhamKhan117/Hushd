"use client";

import { decodeProof, verifyProof, type ReaderProof, type Verdict } from "@hushd/sdk";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { ErrorLine, Field } from "@/components/app/forms";
import { BusyLabel } from "@/components/ui/Spinner";
import { CIRCUITS_BASE, EXAMPLE_READER, NETWORK } from "@/lib/hushd/config";
import { fmt, symbol, TOKENS } from "@/lib/hushd/format";
import "@/styles/pages.css";

const rise = (d: number) => ({ "--d": d }) as CSSProperties;

const KIND_WORDS = { receipt: "Payment", funds: "Funds held", volume: "Desk volume" } as const;

/** Base units to a readable amount when the token is one we list. */
function amountWords(p: ReaderProof, line: string) {
  if (!TOKENS.some((t) => t.id === p.token)) return line;
  return line.replace(/(\d+) \(base units\)/, (_m, n: string) => `${fmt(p.token, BigInt(n))} ${symbol(p.token)}`);
}

const NOT_A_PROOF = "This is not a complete Hushd proof. Check that the whole link or text was copied.";

/** The proof in a hushdproof1… string, or null when it does not decode to one with every field in place. */
function decode(raw: string): ReaderProof | null {
  try {
    const p = decodeProof(raw);
    const complete =
      typeof p.network === "string" &&
      typeof p.pool === "string" &&
      typeof p.reader === "string" &&
      typeof p.token === "string" &&
      typeof p.expiresAtMs === "number" &&
      typeof p.proof === "object" &&
      p.proof !== null &&
      [p.proof.pi_a, p.proof.pi_b, p.proof.pi_c].every(Array.isArray) &&
      Array.isArray(p.publicSignals) &&
      p.publicSignals.every((x) => typeof x === "string");
    return complete ? p : null;
  } catch {
    return null;
  }
}

async function runCheck(raw: string, asReader: string) {
  const p = decode(raw);
  if (!p) throw new Error(NOT_A_PROOF);
  const vkey = await (await fetch(`${CIRCUITS_BASE}/${p.kind}.vkey.json`)).json();
  return { proof: p, verdict: await verifyProof(NETWORK, p, vkey, asReader ? { asReader } : {}) };
}

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

function readerOf(raw: string | null): string | null {
  return raw ? (decode(raw)?.reader ?? null) : null;
}

export default function VerifyPage() {
  // a link carries the proof in the fragment (#p=…), which never reaches a server
  const hash = useSyncExternalStore(subscribeHash, () => location.hash, () => "");
  const linked = new URLSearchParams(hash.slice(1)).get("p");
  const linkedReader = readerOf(linked);
  const [typed, setInput] = useState<string | null>(null);
  const [typedMe, setMe] = useState<string | null>(null);
  const input = typed ?? linked ?? "";
  const me = typedMe ?? linkedReader ?? "";
  const [proof, setProof] = useState<ReaderProof | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // a linked proof is being checked until its verdict or an error arrives
  const working = busy || (Boolean(linked && linkedReader) && !verdict && !error && typed === null);
  // a link whose proof does not decode says so at once, before anyone presses Check
  const shownError = error ?? (linked && !linkedReader && typed === null && !busy ? NOT_A_PROOF : null);

  const check = async (raw: string, asReader: string) => {
    setBusy(true);
    setError(null);
    setVerdict(null);
    try {
      const r = await runCheck(raw, asReader);
      setProof(r.proof);
      setVerdict(r.verdict);
    } catch (e) {
      setProof(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // check a linked proof once, as its own reader
  useEffect(() => {
    if (!linked || !linkedReader) return;
    let live = true;
    runCheck(linked, linkedReader).then(
      (r) => {
        if (!live) return;
        setProof(r.proof);
        setVerdict(r.verdict);
      },
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [linked, linkedReader]);

  return (
    <div className="relative flex min-h-screen flex-col bg-panel text-foreground">
      <Header />
      <main id="main" className="mx-auto w-full max-w-[880px] px-4 pb-20 pt-6 sm:px-6 sm:pt-10">
        <header className="pg-band hd-crop">
          <div className="pg-band-light" aria-hidden />
          <div className="px-5 pb-8 pt-5 sm:px-10 sm:pb-10 sm:pt-7">
            <nav aria-label="Breadcrumb" className="pg-crumbs pg-rise">
              <Link href="/">Hushd</Link>
              <span data-sep aria-hidden>
                /
              </span>
              <span aria-current="page">Proof checker</span>
            </nav>
            <h1 style={rise(1)} className="t-display-l pg-rise mt-10 sm:mt-12">
              Check a Hushd proof
            </h1>
            <p style={rise(2)} className="pg-rise mt-5 max-w-[60ch] text-[15.5px] leading-relaxed text-soft sm:text-[16.5px]">
              A proof shows one fact about private money (a payment, a balance above a line, or desk volume) to one named NEAR account, until it expires. This page checks the zero-knowledge proof in your browser, then asks the pool contract on NEAR to check it again against the chain.
            </p>
          </div>
        </header>

        <section aria-label="Proof checker" style={rise(3)} className="pg-card pg-rise mt-8 grid grid-cols-[minmax(0,1fr)] gap-6 p-5 sm:mt-10 sm:p-8">
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
            <input className="hd-input w-full" placeholder={EXAMPLE_READER} value={me} onChange={(e) => setMe(e.target.value.toLowerCase())} spellCheck={false} autoCapitalize="none" />
          </Field>
          <button type="button" className="btn btn-ink btn-lg btn-block" disabled={!input || working} onClick={() => void check(input, me.trim())} aria-busy={working}>
            <BusyLabel busy={working} busyText="Checking in your browser and on chain…">
              Check
            </BusyLabel>
          </button>
          <ErrorLine error={shownError} />
        </section>

        {proof && verdict && (
          <section className={`pg-card hd-settle mt-6 grid gap-4 p-5 sm:p-7 ${verdict.ok ? "" : "border-danger/40"}`} aria-live="polite">
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
            <dl className="grid gap-1 break-words border-t border-line pt-4 text-[13px] text-mute">
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
      <Footer />
    </div>
  );
}
