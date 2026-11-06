import type { Metadata } from "next";
import Link from "next/link";
import { LegalLayout } from "@/components/LegalLayout";

export const metadata: Metadata = {
  title: "Security",
  description:
    "Where Hushd's security stands: testnet only, development proving keys, not audited, no custody. What protects your notes, what each part is trusted with, and how to report a problem.",
  alternates: { canonical: "/security" },
};

const ISSUES = "https://github.com/ArhamKhan117/Hushd/issues";

export default function SecurityPage() {
  return (
    <LegalLayout
      title="Security"
      label="Trust"
      updated="6 November 2026"
      lede="Where Hushd stands today, without the gloss: what protects you, what it rests on, and how to tell us when something is wrong."
    >
      <h2>Where it stands</h2>
      <ul>
        <li>
          <strong>Testnet only.</strong> Every contract runs on NEAR testnet, with test tokens that have no value.
        </li>
        <li>
          <strong>Development proving keys.</strong> The Groth16 keys come from the public Perpetual Powers of Tau, one
          phase-2 contribution and a public beacon. Whoever made that contribution could have kept its entropy and
          forged proofs. Real value needs a multi-party ceremony first.
        </li>
        <li>
          <strong>Not audited.</strong> The contracts, circuits and services have tests. No external audit has been done.
        </li>
      </ul>

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
