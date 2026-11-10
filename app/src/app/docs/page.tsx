import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Hushd docs: a private OTC desk on NEAR testnet where agents quote, trade and settle. How a deal works, packages, proofs to one named reader, agents, makers, the SDK and the privacy model.",
  alternates: { canonical: "/docs" },
};

export default function DocsOverviewPage() {
  return (
    <DocsLayout
      title="Hushd docs"
      lede="A private OTC desk on NEAR testnet where agents quote, trade and settle. What it is, what works today, and where to start."
      glance={[
        { label: "Network", value: "NEAR testnet" },
        { label: "Tokens", value: "USDC, wNEAR, BTC (test)" },
        { label: "Proving keys", value: "Development keys" },
        { label: "Audit", value: "Not audited" },
      ]}
    >
      <h2 id="what-hushd-is">What Hushd is</h2>
      <p>
        Hushd is an over-the-counter desk where the request, the quotes and the settlement stay private. You say what
        you want to trade, in plain words or in a form. Maker agents, automated and pricing by formula, quote. A
        matcher running inside a trusted execution environment (TEE) picks the best quote inside your limit, and both
        sides settle from their private balances in one call on NEAR. Your own agent can do the trading too, through
        MCP.
      </p>
      <p>
        Your money sits in a <strong>shielded pool</strong> as notes: Poseidon commitments in a Merkle tree of depth
        20, spent with Groth16 proofs that the pool contract checks on chain. Only the holder of a note&apos;s
        spending key can spend it. You can send privately, pay anyone as a link they claim with a passkey or a wallet,
        cash out to any NEAR account, share a payment request link, and receive at an address that starts with{" "}
        <code>hushd1</code>.
      </p>
      <p>
        When someone needs to see one fact, you make a <strong>proof for one named NEAR account</strong>, with an
        expiry: a payment, a balance above a line, or your total desk volume. Anyone holding it can check it at{" "}
        <Link href="/verify">/verify</Link>, and it says who it was made for.
      </p>

      <FlowDiagram
        title="A deal, in four steps"
        steps={[
          { n: "1", title: "Sealed request", body: "Sealed to the matcher enclave. Only its sha256 goes on chain." },
          { n: "2", title: "Enclave match", body: "Makers quote, sealed and signed. The enclave picks the best inside your limit." },
          { n: "3", title: "Atomic settlement", body: "Both legs proven and settled in one pool call: both happen or neither." },
          { n: "4", title: "Receipt", body: "Settled, recovered, failed or unresolved, with evidence, on the desk." },
        ]}
      />

      <h2 id="what-works-today">What works today</h2>
      <ul>
        <li>
          Sign in with a NEAR wallet through NEAR Connect, or with a passkey that derives a NEAR implicit account (the
          relayer gives it a little testnet NEAR).
        </li>
        <li>Test tokens from a faucet: USDC, wNEAR and BTC, all issued by Hushd on testnet.</li>
        <li>Add privately, send privately, cash out (with a refund note if the payout fails), receive and request.</li>
        <li>
          Pay as a link: anyone who opens it claims the payment into their own private balance, with no gas and no
          seed phrase, and you can take back a link nobody claimed. See{" "}
          <Link href="/docs/privacy-model#claim-links">claim links</Link>.
        </li>
        <li>
          The desk: <Link href="/docs/packages">spot</Link>, matched in the enclave and settled atomically in the
          pool, and the experimental spot + hedge and cash and carry, where the maker bonds a hedge order it places on
          Hyperliquid testnet for its own account.
        </li>
        <li>
          Plain-language intake on NEAR AI Cloud: your words are encrypted in the browser to an attested model, and its
          signed answer is checked before you see the draft.
        </li>
        <li>
          <Link href="/docs/proofs">Proofs to one named reader</Link>, checked in the browser and by the pool
          contract.
        </li>
        <li>
          <Link href="/docs/agents">An MCP server</Link> with spending limits, <Link href="/docs/x402">private x402</Link>,
          and <Link href="/docs/makers">reference makers</Link> that sell indicative quotes over x402.
        </li>
      </ul>

      <h2 id="what-it-is-not">What it is not</h2>
      <p>
        Hushd runs on testnet only. The tokens have no value, the proving keys are development keys from one
        contribution (not a multi-party ceremony), and nothing has been audited. Hedged packages are experimental:
        their hedge leg trades on Hyperliquid testnet for the maker&apos;s own account, and none has filled yet. Read <Link href="/docs/threat-model">the threat model</Link> before you rely on any part of it.
      </p>
      <Callout tone="caveat" title="Some things stay public">
        Deposits into the pool and cash outs from it are public, with their amounts. So is the fact that a desk deal
        happened and how it ended. What happens inside the pool, and who traded what, is not.{" "}
        <Link href="/docs/privacy-model">The privacy model</Link> lists it all.
      </Callout>

      <h2 id="where-to-start">Where to start</h2>
      <ul>
        <li>
          <Link href="/docs/quickstart">Quickstart</Link>: your first private deal on testnet, in a few minutes.
        </li>
        <li>
          <Link href="/docs/desk">How the desk works</Link>: the request, the match and settlement, step by step.
        </li>
        <li>
          <Link href="/docs/agents">Agents and MCP</Link>: give an agent a private balance and a seat at the desk.
        </li>
        <li>
          <Link href="/docs/sdk">SDK</Link>: build on the same TypeScript the app uses.
        </li>
        <li>
          <Link href="/docs/contracts">Contracts</Link>: the accounts on testnet and what each one does.
        </li>
        <li>
          Or go straight to the <AppLink href="/app">desk</AppLink>.
        </li>
      </ul>
    </DocsLayout>
  );
}
