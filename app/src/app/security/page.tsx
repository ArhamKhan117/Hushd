import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { LegalLayout } from "@/components/LegalLayout";
import { Reveal } from "@/components/ui/Reveal";
import { Spotlight } from "@/components/ui/Spotlight";

export const metadata: Metadata = {
  title: "Security",
  description:
    "Where Hushd's security stands: testnet only, development proving keys, not audited, no custody. What protects your notes, what each part is trusted with, and how to report a problem.",
  alternates: { canonical: "/security" },
};

const ISSUES = "https://github.com/ArhamKhan117/Hushd/issues";

const icon = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", "aria-hidden": true } as const;

/** Where it stands, as three cells on one hairline grid. */
const STANDING: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "Testnet only",
    body: "Every contract runs on NEAR testnet, with test tokens that have no value.",
    icon: (
      <svg {...icon}>
        <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.3" />
        <path d="M3.75 12h16.5M12 3.75c2.3 2.4 3.4 5.15 3.4 8.25s-1.1 5.85-3.4 8.25c-2.3-2.4-3.4-5.15-3.4-8.25S9.7 6.15 12 3.75z" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    ),
  },
  {
    title: "Development proving keys",
    body: "The Groth16 keys come from the public Perpetual Powers of Tau, one phase-2 contribution and a public beacon. Whoever made that contribution could have kept its entropy and forged proofs. Real value needs a multi-party ceremony first.",
    icon: (
      <svg {...icon}>
        <circle cx="8.5" cy="12" r="3.75" stroke="currentColor" strokeWidth="1.3" />
        <path d="M12.25 12h8M17.5 12v3M20.25 12v2.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    title: "Not audited",
    body: "The contracts, circuits and services have tests and automated security scans, and every contract on testnet is a reproducible build anyone can rebuild from its commit. No external audit has been done.",
    icon: (
      <svg {...icon}>
        <path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3l7-2.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M9.5 12h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
];

export default function SecurityPage() {
  return (
    <LegalLayout
      title="Security"
      label="Trust"
      updated="6 November 2026"
      lede="Where Hushd stands today, without the gloss: what protects you, what it rests on, and how to tell us when something is wrong."
    >
      <h2>Where it stands</h2>
      <Reveal className="pg-facts pg-bento hd-grid-lines grid sm:grid-cols-3" stagger={90}>
        {STANDING.map((f) => (
          <Spotlight key={f.title} data-reveal-item className="flex flex-col p-5 sm:p-6">
            <span className="pg-icon">{f.icon}</span>
            <strong className="mt-8 block text-[16px] leading-snug tracking-[-0.01em] text-foreground">{f.title}</strong>
            <span className="mt-2 block text-[14px] leading-[1.6] text-mute">{f.body}</span>
          </Spotlight>
        ))}
      </Reveal>

      <h2>What protects your notes</h2>
      <ul>
        <li>Only the holder of a note&apos;s spending key can spend it. The pool has no admin withdraw.</li>
        <li>
          Every spend is a Groth16 proof the pool checks on chain, with NEAR&apos;s <code>alt_bn128</code> host
          functions. A cash out&apos;s recipient, fee and refund note are bound into the proof.
        </li>
        <li>Both legs of a spot deal settle in one call, or neither does.</li>
        <li>
          Pool rule changes wait out a public timelock. The owner can pause new deposits, never cash outs.
        </li>
      </ul>

      <h2>What it rests on</h2>
      <ul>
        <li>
          <strong>The relayer</strong> can refuse or delay an action, never change it.
        </li>
        <li>
          <strong>The matcher enclave</strong> keeps requests, limits and quotes private and applies your limit. That
          rests on its TEE (Intel TDX, run by OutLayer).
        </li>
        <li>
          <strong>The intake model</strong> reads your words inside NEAR AI Cloud&apos;s attested TEE. It only drafts.
        </li>
        <li>
          <strong>Hushd&apos;s API</strong> passes on sealed messages it cannot open, but sees IP addresses, timing and
          deal-room traffic. <strong>The matcher client</strong> builds the enclave&apos;s batch of quotes and could
          leave one out. <strong>The keeper</strong> alone reports whether a hedge filled, which releases or slashes the
          maker&apos;s bond.
        </li>
        <li>
          <strong>The app you load</strong> handles your seed. It is open source, and you can build and run it yourself.
        </li>
      </ul>
      <p>
        Each of these, and what happens if it fails, is in <Link href="/docs/threat-model">the threat model</Link>.
      </p>

      <h2>Report a problem</h2>
      <p>
        Open an issue on{" "}
        <a href={ISSUES} target="_blank" rel="noreferrer">
          GitHub
        </a>
        . If the problem could put someone at risk, write only that you found one and ask for a private way to share
        it. Please do not post details until a fix is out. There is no paid bug bounty.
      </p>

      <h2>Testing rules</h2>
      <ul>
        <li>Test against NEAR testnet or a local sandbox.</li>
        <li>Do not degrade the shared faucet, relayer or API for others.</li>
        <li>Do not try to read or move anyone else&apos;s data or notes.</li>
      </ul>

      <h2>In scope</h2>
      <p>
        The contracts in <code>contracts/</code>, the circuits in <code>circuits/</code>, the matcher in{" "}
        <code>matcher/</code>, the services in <code>services/</code>, the SDK and MCP server in <code>packages/</code>,
        and the app at hushd.net.
      </p>
    </LegalLayout>
  );
}
