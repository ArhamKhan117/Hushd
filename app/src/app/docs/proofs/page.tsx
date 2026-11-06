import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Proofs",
  description:
    "Prove one fact about private money to one named NEAR account, with an expiry: an exact payment, a payment of at least an amount, funds above a threshold, or total desk volume. Checked in the browser and by the pool contract.",
  alternates: { canonical: "/docs/proofs" },
};

export default function ProofsPage() {
  return (
    <DocsLayout
      title="Proofs"
      lede="Show one reader exactly what they need, and nothing else. Every proof names its reader and expires."
      glance={[
        { label: "Kinds", value: "Payment, funds, volume" },
        { label: "Reader", value: "One NEAR account" },
        { label: "Checked", value: "Browser and pool contract" },
      ]}
    >
      <h2 id="what-a-proof-is">What a proof is</h2>
      <p>
        A zero-knowledge proof about your notes, made on your device. It shows one statement, such as &ldquo;I paid
        at least this much of this token&rdquo;, without showing the notes behind it. Hushd binds each proof to a{" "}
        <strong>context</strong>: the reader&apos;s NEAR account, an expiry, the network and the pool. The context is
        one of the proof&apos;s public inputs, so changing the reader or the expiry after proving makes it fail.
      </p>

      <h2 id="the-four-kinds">The four kinds</h2>
      <table>
        <thead>
          <tr>
            <th>In the app</th>
            <th>Circuit</th>
            <th>What it shows</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Exact payment</td>
            <td>
              <code>receipt</code>
            </td>
            <td>You made a payment, or a desk deal leg, of exactly this amount of a token</td>
          </tr>
          <tr>
            <td>Paid at least</td>
            <td>
              <code>receipt</code>
            </td>
            <td>The same payment reached at least an amount you choose; the exact amount stays hidden</td>
          </tr>
          <tr>
            <td>Funds held</td>
            <td>
              <code>funds</code>
            </td>
            <td>You hold at least a threshold of a token, in one to four unspent notes</td>
          </tr>
          <tr>
            <td>OTC volume</td>
            <td>
              <code>volume</code>
            </td>
            <td>You delivered exactly this total of a token across one to sixteen desk deal legs, and how many</td>
          </tr>
        </tbody>
      </table>

      <h2 id="one-named-reader">One named reader</h2>
      <p>
        The reader is a NEAR account, such as <code>auditor.testnet</code>. A proof can be copied, like any file. What
        it cannot do is pass for someone else&apos;s: anyone checking it is told who it was made for, and the checker
        at <Link href="/verify">/verify</Link> asks who you are and flags a proof made for another account rather than
        quietly accepting it.
      </p>

      <h2 id="expiry">Expiry</h2>
      <p>
        You choose how long a proof is valid: one day, seven or thirty in the app, up to ninety over MCP. After that,
        every checker refuses it. A funds proof also stops holding as soon as you spend a note behind it, or once the
        pool has moved more than 100 roots past the one it was proved against: it shows what you hold now, not what
        you once held.
      </p>

      <h2 id="checking-a-proof">Checking a proof</h2>
      <p>
        A proof is shared as one string that starts with <code>hushdproof1</code>, usually as a link:{" "}
        <code>https://hushd.net/verify#p=hushdproof1…</code>. Everything after the <code>#</code> stays in the browser.
        The checker then:
      </p>
      <ol>
        <li>checks the proof was made for this network and this pool,</li>
        <li>rebuilds the context from the reader and expiry, and compares it with the proof&apos;s,</li>
        <li>refuses it if it has expired, or names a different reader than you,</li>
        <li>checks the Groth16 proof against the circuit&apos;s verifying key, in your browser, and</li>
        <li>
          asks the pool contract&apos;s <code>verify_disclosure</code> view to check it again against the chain.
        </li>
      </ol>
      <p>
        The pool checks what only the chain knows. For a payment, that the note you paid with was really spent into
        the note the proof names. For funds, that the root is one it still keeps and no note behind the proof has been
        spent since. For volume, that every leg was a desk settlement, and none is counted twice. Any problem is
        listed in plain words.
      </p>
      <Callout title="The label is not proven">
        A proof can carry a label in your words, like what the payment was for. The checker shows it, marked as not
        proven.
      </Callout>

      <h2 id="what-a-proof-does-not-show">What a proof does not show</h2>
      <ul>
        <li>Your other notes, your balance, or your NEAR account.</li>
        <li>A funds proof shows the threshold, never the balance above it.</li>
        <li>
          A payment proof shows who was paid only if you choose to show the payee&apos;s receive key.
        </li>
      </ul>
      <p>
        One thing a reader does learn: for a payment that settled a desk deal, and for every leg of a volume proof, the
        pool reports which deal it was. Deal records are public, so the reader can see when those deals happened and
        how they ended.
      </p>

      <h2 id="making-one">Making one</h2>
      <ul>
        <li>
          In the app: <AppLink href="/app/prove">Prove</AppLink>. Pick what to show, the reader and the expiry, then
          share the link.
        </li>
        <li>
          From an agent: the <code>hushd_prove</code> MCP tool, with <code>what</code> set to <code>payment</code>,{" "}
          <code>payment_at_least</code>, <code>funds</code> or <code>volume</code>. See{" "}
          <Link href="/docs/agents">agents</Link>.
        </li>
        <li>
          In code: <code>proveReceipt</code>, <code>proveFunds</code> and <code>proveVolume</code>, then{" "}
          <code>encodeProof</code>. Check one with <code>verifyProof</code>. See <Link href="/docs/sdk#proofs">the SDK</Link>.
        </li>
      </ul>
      <pre>
        <code className="language-ts">{`import { encodeProof, proveFunds, TESTNET } from "@hushd/sdk";

// At least 1,000 USDC, for auditor.testnet only, valid for 7 days.
const proof = await proveFunds(artifacts, identity, {
  net: TESTNET,
  reader: "auditor.testnet",
  expiresAtMs: Date.now() + 7 * 86_400_000,
}, wallet.merkleTree, wallet.spendable("usdc.hushd.testnet").slice(0, 4), 1_000_000_000n);

const link = \`https://hushd.net/verify#p=\${encodeProof(proof)}\`;`}</code>
      </pre>
    </DocsLayout>
  );
}
