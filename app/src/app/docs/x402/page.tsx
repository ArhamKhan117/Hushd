import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Private x402",
  description:
    "Pay for an HTTP resource from a private balance with the x402 scheme \"hushd\", and check such a payment on your server. Nobody watching NEAR learns who paid whom or how much.",
  alternates: { canonical: "/docs/x402" },
};

export default function X402Page() {
  return (
    <DocsLayout
      title="Private x402"
      lede="HTTP 402 payments from a private balance. The server gets paid and can check it; the chain shows a pool transaction, not who paid whom or how much."
      glance={[
        { label: "Scheme", value: "hushd" },
        { label: "Network", value: "near-testnet" },
        { label: "Header", value: "X-PAYMENT" },
      ]}
    >
      <h2 id="how-it-works">How it works</h2>
      <FlowDiagram
        title="One paid request"
        steps={[
          { n: "1", title: "402", body: "The resource answers with its price, the token and a hushd1… address to pay." },
          { n: "2", title: "Pay privately", body: "The client sends a private payment to that address through the relayer." },
          { n: "3", title: "Retry", body: "With X-PAYMENT: the transaction, the note's commitment, and its opening sealed to the payee." },
          { n: "4", title: "Check and serve", body: "The server opens the note, checks the amount and that the pool made it, then serves." },
        ]}
      />
      <p>
        The code is in <code>packages/sdk/src/x402.ts</code>: <code>paymentRequired</code> and{" "}
        <code>verifyX402Payment</code> for a server, <code>x402Fetch</code> for a client.
      </p>

      <h2 id="the-402-answer">The 402 answer</h2>
      <p>
        A resource that wants a private payment answers <code>402 Payment Required</code> with an{" "}
        <code>accepts</code> entry of scheme <code>hushd</code>:
      </p>
      <pre>
        <code className="language-json">{`{
  "x402Version": 1,
  "error": "Payment required",
  "accepts": [{
    "scheme": "hushd",
    "network": "near-testnet",
    "maxAmountRequired": "10000",
    "asset": "usdc.hushd.testnet",
    "payTo": "hushd1…",
    "resource": "https://example.com/report",
    "maxTimeoutSeconds": 120,
    "extra": { "pool": "pool.hushd.testnet" }
  }]
}`}</code>
      </pre>
      <p>
        <code>maxAmountRequired</code> is in the token&apos;s base units (here 0.01 test USDC, which has 6 decimals),
        and <code>payTo</code> is the server&apos;s receive address.
      </p>

      <h2 id="paying">Paying</h2>
      <p>
        <code>x402Fetch</code> fetches the URL; on a <code>hushd</code> 402 for this network it pays from the wallet,
        then fetches again with the <code>X-PAYMENT</code> header. You pass a cap per token, and a price above it is
        refused, never paid.
      </p>
      <pre>
        <code className="language-ts">{`import { x402Fetch } from "@hushd/sdk";

const { response, paid } = await x402Fetch(wallet, "https://example.com/report", {}, {
  // the most one call may pay, per token, in base units
  maxAmount: (token) => (token === "usdc.hushd.testnet" ? 1_000_000n : 0n),
});`}</code>
      </pre>
      <p>
        The header is base64 JSON with the scheme, the network and a payload of four fields: the transaction hash,
        the account that sent it (the relayer), the commitment of the note made for the payee, and that note&apos;s
        opening, sealed to the payee&apos;s key. From an agent, the MCP tool <code>hushd_pay_x402</code> does all of
        this inside the agent&apos;s <Link href="/docs/agents#spending-limits">spending limits</Link>.
      </p>

      <h2 id="checking-a-payment">Checking a payment</h2>
      <pre>
        <code className="language-ts">{`import { paymentRequired, paymentResponse, verifyX402Payment, x402Network, TESTNET } from "@hushd/sdk";

const price = { maxAmountRequired: "10000", asset: "usdc.hushd.testnet" };

const header = req.headers.get("x-payment");
if (!header) return json(paymentRequired(TESTNET, { ...price, payTo: me.address, resource: req.url }), 402);

const paid = await verifyX402Payment(TESTNET, me, header, price, seen);
if (!paid.ok) return json({ error: paid.reason }, 402);

// serve, and say which transaction paid for it
return json(body, 200, { "x-payment-response": paymentResponse({ txHash: paid.txHash, network: x402Network(TESTNET) }) });`}</code>
      </pre>
      <p>
        <code>me</code> is the server&apos;s Hushd identity. <code>verifyX402Payment</code> refuses the payment unless
        every one of these holds:
      </p>
      <ol>
        <li>the scheme is <code>hushd</code> and the network is this one,</li>
        <li>the commitment has not been used before,</li>
        <li>the opening is sealed to this payee and opens to that exact commitment under its receive key,</li>
        <li>the note is in the asked token, for at least the price,</li>
        <li>the transaction is final and successful, and</li>
        <li>the pool&apos;s <code>transact</code> event in that transaction created exactly that note.</li>
      </ol>

      <h2 id="replays">Replays</h2>
      <p>
        <code>seen</code> is your record of commitments already accepted: anything with <code>has</code> and{" "}
        <code>add</code>. Keep it for as long as you accept payments, and on disk if the server restarts, as the
        reference makers do. Each payment note can then pay for one request only.
      </p>

      <h2 id="what-the-chain-shows">What the chain shows</h2>
      <p>
        One pool <code>transact</code> sent by the relayer, with two new note commitments, and a separate encrypted
        board post. Not the payer, not the payee and not the amount. The payee learns the amount and gets a note only it can spend. The
        payee does not learn the payer&apos;s account either: the transaction comes from the relayer.
      </p>
      <Callout title="Spendable on the next sync">
        The payee&apos;s wallet finds the note on its next sync, like any private payment, and it is spendable at once.
      </Callout>

      <h2 id="maker-quotes">A live example: maker quotes</h2>
      <p>
        The reference makers sell indicative quotes over private x402 at{" "}
        <code>https://api.hushd.net/makers/&lt;maker account&gt;/quote?sell=&amp;amount=&amp;buy=</code>, with the
        amount in base units. Without a payment it answers 402; with one, a quote that is valid for 30 seconds. See{" "}
        <Link href="/docs/makers#selling-quotes-over-x402">makers</Link>.
      </p>
      <pre>
        <code className="language-bash">{`curl -i "https://api.hushd.net/makers/maker-a.hushd.testnet/quote?sell=usdc.hushd.testnet&amount=1000000000&buy=btc.hushd.testnet"
# HTTP/1.1 402 Payment Required`}</code>
      </pre>
    </DocsLayout>
  );
}
