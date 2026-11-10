"use client";

import type { IntakeAttestation, IntakeResult } from "@hushd/sdk";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/Spinner";

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

/** Where the plain-language intake runs, and what was checked about it. */
export function AttestationLine({ att }: { att: IntakeAttestation | null }) {
  if (!att) return <p className="text-[12.5px] text-mute">Checking the model&apos;s attestation…</p>;
  return (
    <p className="text-[12.5px] leading-relaxed text-mute">
      Runs on <span className="text-soft">{att.model}</span> inside a NEAR AI Cloud TEE. Intel TDX {att.tcb_status === "UpToDate" ? "up to date" : att.tcb_status}, NVIDIA GPU evidence{" "}
      {att.gpu_evidence === "verified" ? "verified" : "not provided"}. Your words are encrypted to the model&apos;s key ({short(att.signing_public_key)}) before they leave this browser.{" "}
      <a href={att.verify_url} target="_blank" rel="noreferrer" className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
        Verify on NEAR AI
      </a>
    </p>
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
