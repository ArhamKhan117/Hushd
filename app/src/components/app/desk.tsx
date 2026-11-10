"use client";

import type { IntakeAttestation, IntakeResult } from "@hushd/sdk";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/Spinner";
import { when } from "@/lib/hushd/deal";

/** A small set of choices as chips; the chosen one is inked. */
export function Segmented<V extends string>({ value, onChange, options, label }: { value: V; onChange: (v: V) => void; options: readonly { value: V; label: string; hint?: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o.value} type="button" className="hd-chip" aria-pressed={o.value === value} title={o.hint} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type StepState = "todo" | "doing" | "done" | "failed";

export interface Step {
  key: string;
  label: string;
  state: StepState;
  detail?: ReactNode;
}

function Mark({ state }: { state: StepState }) {
  if (state === "doing") return <Spinner className="h-4 w-4 text-foreground" />;
  if (state === "done")
    return (
      <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full bg-ink text-on-ink">
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2.5 6.2 5 8.5 9.5 3.5" />
        </svg>
      </span>
    );
  if (state === "failed") return <span aria-hidden className="grid h-4 w-4 place-items-center rounded-full bg-danger text-[10px] font-semibold text-on-ink">!</span>;
  return <span aria-hidden className="block h-4 w-4 rounded-full border border-line-strong" />;
}

/** The life of a deal, step by step, with what each step put on chain. */
export function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="grid gap-0">
      {steps.map((s, i) => (
        <li key={s.key} className="relative flex gap-3 pb-4 last:pb-0">
          {i < steps.length - 1 && <span aria-hidden className="absolute left-[7.5px] top-5 h-[calc(100%-16px)] w-px bg-line" />}
          <span className="mt-0.5 shrink-0">
            <Mark state={s.state} />
          </span>
          <span className="min-w-0">
            <span className={`block text-[14.5px] ${s.state === "todo" ? "text-mute" : "text-foreground"}`}>{s.label}</span>
            {s.detail && <span className="mt-0.5 block text-[13px] leading-relaxed text-mute">{s.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

/** The verifier link the API names, only when it is a plain https link. */
const verifierUrl = (att: IntakeAttestation) => (/^https:\/\/[^\s"'<>]+$/.test(att.verify_url) ? att.verify_url : null);

const TCB_WORDS: Record<string, string> = { UpToDate: "up to date", OutOfDate: "out of date", Revoked: "revoked" };

/** Where the plain-language intake runs, and what was checked about it. */
export function AttestationLine({ att }: { att: IntakeAttestation | null }) {
  if (!att) return <p className="text-[12.5px] text-mute">Checking the model&apos;s attestation…</p>;
  return (
    <p className="text-[12.5px] leading-relaxed text-mute">
      Runs on <span className="text-soft">{att.model}</span> inside a NEAR AI Cloud TEE. Intel TDX {att.tcb_status === "UpToDate" ? "up to date" : att.tcb_status}, NVIDIA GPU evidence{" "}
      {att.gpu_evidence === "verified" ? "verified" : "not provided"}. Your words are encrypted to the model&apos;s key ({short(att.signing_public_key)}) before they leave this browser.
      {verifierUrl(att) && (
        <>
          {" "}
          <a href={verifierUrl(att)!} target="_blank" rel="noreferrer" className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
            Verify on NEAR AI
          </a>
        </>
      )}
      {!att.enabled && <span className="mt-1 block text-soft">The intake is off on this API: it holds no NEAR AI key. Fill the form instead.</span>}
    </p>
  );
}

/** The intake is off: why, and the form, which asks for the same request. */
export function IntakeOff({ reason, onForm }: { reason: string; onForm: () => void }) {
  return (
    <div className="hd-tile grid gap-3 px-4 py-4 sm:px-5" role="status" aria-label="The intake is off">
      <p className="text-[14.5px] text-foreground">The intake is off for now</p>
      <p className="text-[13px] leading-relaxed text-soft">
        The model&apos;s attestation could not be checked, so nothing you type here is sent anywhere. The form asks for the same request, and you set every number yourself.
      </p>
      <p className="break-words text-[12.5px] text-mute">The Hushd API said: {reason}</p>
      <div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onForm}>
          Fill the form
        </button>
      </div>
    </div>
  );
}

/**
 * What the Hushd API verified about the model: the browser checks the answer's signature
 * itself (`IntakeProof`), but the Intel TDX quote and the NVIDIA GPU evidence behind the key
 * are checked on the API. This shows what it returned, and where to check it yourself.
 */
export function AttestationCheck({ att }: { att: IntakeAttestation }) {
  const url = verifierUrl(att);
  const rows: [string, ReactNode][] = [
    ["Model", att.model],
    ["Signing key", att.signing_public_key],
    ["Intel TDX", TCB_WORDS[att.tcb_status] ?? att.tcb_status],
    ["NVIDIA GPU evidence", att.gpu_evidence === "verified" ? "verified" : "not provided"],
    ["Verified by the API", Number.isFinite(att.verified_at_ms) && att.verified_at_ms > 0 ? <time dateTime={new Date(att.verified_at_ms).toISOString()}>{when(att.verified_at_ms)}</time> : "not said"],
  ];
  return (
    <section className="hd-tile grid gap-3 px-4 py-3 text-[12.5px] text-mute" aria-label="The model's attestation">
      <p className="text-soft">The model&apos;s attestation</p>
      <dl className="grid gap-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-x-3 sm:grid-cols-[150px_minmax(0,1fr)]">
            <dt className="text-soft">{k}</dt>
            <dd className="break-all">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="leading-relaxed">
        This part is checked by the Hushd API, not by your browser: to check it yourself, open NEAR AI&apos;s verifier and compare the model and the signing key it shows with the ones above.
      </p>
      {url && (
        <a href={url} target="_blank" rel="noreferrer" className="justify-self-start text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
          Check it yourself on NEAR AI
        </a>
      )}
    </section>
  );
}

type Check = keyof IntakeResult["proof"]["checks"];

/** Each check the browser makes: what it shows when it holds, and when it does not. */
const CHECKS: [Check, string, string][] = [
  ["signerIsAttested", "Signed by the attested key your words were encrypted to", "the answer is signed by a key other than the attested one"],
  ["signatureValid", "The signature checks out against that key", "the signature does not check out against the attested key"],
  ["hashesMatch", "It signs this exact request and response", "the signature is over another request or response"],
  ["apiVerified", "The API checked it against the attestation too", "the API did not confirm it against the attestation"],
];

/** What the browser checked about one intake answer: verified only when every check holds. */
export function IntakeProof({ proof }: { proof: IntakeResult["proof"] }) {
  const failed = CHECKS.find(([k]) => !proof.checks[k]);
  return (
    <details className="hd-tile px-4 py-3 text-[12.5px] text-mute" open={!proof.verified}>
      <summary className={`cursor-pointer select-none ${proof.verified ? "text-soft" : "text-danger"}`}>
        {proof.verified ? "Answer signed inside the TEE by the attested key, checked in this browser" : `Not verified: ${failed?.[2] ?? "a check failed"}. Check every number yourself.`}
      </summary>
      <ul className="mt-3 grid gap-1.5" aria-label="Checks on this answer">
        {CHECKS.map(([k, label]) => (
          <li key={k} className="flex items-start gap-2">
            <span className={`shrink-0 ${proof.checks[k] ? "text-soft" : "text-danger"}`}>{proof.checks[k] ? "Yes" : "No"}</span>
            <span>{label}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-3 grid gap-1.5 break-all">
        <div>
          <dt className="inline text-soft">Model: </dt>
          <dd className="inline">{proof.model}</dd>
        </div>
        <div>
          <dt className="inline text-soft">Chat id: </dt>
          <dd className="inline">{proof.chatId}</dd>
        </div>
        <div>
          <dt className="inline text-soft">sha256(request): </dt>
          <dd className="inline">{proof.requestHash}</dd>
        </div>
        <div>
          <dt className="inline text-soft">sha256(response): </dt>
          <dd className="inline">{proof.responseHash}</dd>
        </div>
        <div>
          <dt className="inline text-soft">Attested key: </dt>
          <dd className="inline">{proof.attestedKey}</dd>
        </div>
        <div>
          <dt className="inline text-soft">Signed by: </dt>
          <dd className="inline">
            {proof.signingKey || "nobody named"} ({proof.signatureKind})
          </dd>
        </div>
      </dl>
    </details>
  );
}
