import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Quickstart",
  description:
    "Your first private deal on Hushd: sign in with a NEAR wallet or a passkey, get test tokens, add them privately, ask the desk and prove it to one reader. NEAR testnet only.",
  alternates: { canonical: "/docs/quickstart" },
};

export default function QuickstartPage() {
  return (
    <DocsLayout
      title="Quickstart"
      lede="From nothing to a private deal on NEAR testnet in a few minutes. Everything here uses test tokens with no value."
      glance={[
        { label: "You need", value: "A browser" },
        { label: "Sign in with", value: "NEAR wallet or passkey" },
        { label: "Costs", value: "Test tokens only" },
      ]}
    >
      <h2 id="what-you-need">What you need</h2>
      <p>
        A browser that supports passkeys, or a NEAR testnet wallet that NEAR Connect lists (HOT, Meteor, Intear and
        others). Nothing to install. If you use a wallet, keep a little testnet NEAR in it for the gas of your own
        deposit.
      </p>

      <h2 id="1-sign-in">1. Sign in</h2>
      <p>
        Open the <AppLink href="/app">desk</AppLink> and pick one:
      </p>
      <ul>
        <li>
          <strong>Connect a NEAR wallet.</strong> Then sign one fixed message (NEP-413). The seed of your private
          balance is derived from a hash of that signature: the signature never leaves the device, moves no funds, and
          the same wallet key opens the same balance on any device.
        </li>
        <li>
          <strong>Create a passkey.</strong> The passkey&apos;s PRF output is the seed. It also derives a NEAR implicit
          account, which the relayer funds with a little testnet NEAR so it can sign its own deposits. No wallet and no
          seed phrase.
        </li>
      </ul>

      <h2 id="2-get-test-tokens">2. Get test tokens</h2>
      <p>
        Go to <AppLink href="/app/balance/add">Add privately</AppLink>, pick USDC, wNEAR or BTC, and press{" "}
        <strong>Get test</strong> under the amount. The faucet gives a fixed amount to each account once an hour. With
        a passkey the relayer asks the faucet for you, since your new account has no gas yet.
      </p>

      <h2 id="3-add-privately">3. Add privately</h2>
      <p>
        Enter an amount and press <strong>Add privately</strong>. Your account sends the tokens to the pool with{" "}
        <code>ft_transfer_call</code>. The pool builds your note from what it actually received, so a deposit can never
        claim more than it sends. A copy of the note is posted to the board, encrypted to you, so your seed alone
        recovers it on another device.
      </p>
      <Callout title="This step is public">
        The deposit shows your NEAR account, the token and the amount. What you do with the note afterwards does not.
      </Callout>

      <h2 id="4-ask-the-desk">4. Ask the desk</h2>
      <p>
        Back on the <AppLink href="/app">desk</AppLink>, either describe the deal in your own words (for example,
        &ldquo;Sell 500 USDC for BTC at the best price&rdquo;) and let the model draft it, or fill the form:
      </p>
      <ul>
        <li>
          <strong>Package</strong>: spot, or the experimental spot + hedge and cash and carry. On a hedged package you
          receive the spot leg, and the maker bonds a hedge order it places for its own account; it needs a bond of at
          least 1,000 USDC, so it makes sense from about 10,000 USDC. See <Link href="/docs/packages">packages</Link>.
        </li>
        <li>
          <strong>You sell</strong> and <strong>you buy</strong>: the tokens and the amount you sell, from your private
          balance.
        </li>
        <li>
          <strong>Least you accept</strong>: your limit. Only the enclave reads it. Leave it empty to take the best
          quote.
        </li>
        <li>
          <strong>Quote window</strong>: how long makers have to answer (20, 45 or 90 seconds).
        </li>
      </ul>
      <p>
        A drafted request always lands in the form first. Check every number there before you ask: the model only
        drafts. Then the desk shows each step as it happens: sealed to the enclave, committed on chain, makers
        quoting, matched, settling, settled.
      </p>

      <h2 id="5-read-the-receipt">5. Read the receipt</h2>
      <p>
        <AppLink href="/app/deals">Deals</AppLink> lists the deals you took part in, with the terms only you can read,
        and the desk&apos;s public receipt for each: settled, recovered, failed or unresolved, with its evidence. Your
        balance now holds the note the maker made for you.
      </p>

      <h2 id="6-prove-it">6. Prove it to one reader</h2>
      <p>
        In <AppLink href="/app/prove">Prove</AppLink>, choose what to show (an exact payment, a payment of at least an
        amount, funds held, or desk volume), name the NEAR account that may read it, and how long it is valid. You get
        a link to <Link href="/verify">/verify</Link> that the reader opens. See <Link href="/docs/proofs">proofs</Link>.
      </p>

      <h2 id="if-something-goes-wrong">If something goes wrong</h2>
      <ul>
        <li>
          <strong>No quotes.</strong> Makers quote only what they can fill from their own private balance. Try a
          smaller size or another pair.
        </li>
        <li>
          <strong>No match.</strong> Every quote was below your limit. Your limit never left the enclave, and nothing
          was settled.
        </li>
        <li>
          <strong>A deal that never settles</strong> expires, and its receipt says it failed. Neither side&apos;s
          notes were spent.
        </li>
        <li>
          <strong>A cash out the token refuses</strong> (an account not registered for the token, say) comes back as a
          refund note in your private balance.
        </li>
      </ul>

      <h2 id="next">Next</h2>
      <ul>
        <li>
          <Link href="/docs/desk">How the desk works</Link>
        </li>
        <li>
          <Link href="/docs/privacy-model">What stays private, and what does not</Link>
        </li>
        <li>
          <Link href="/docs/agents">Do the same from an agent, over MCP</Link>
        </li>
      </ul>
    </DocsLayout>
  );
}
