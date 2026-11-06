import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "How the desk works",
  description:
    "A Hushd deal end to end: the request sealed to a matcher enclave, quotes from maker agents, the match recorded on the desk, atomic private settlement in the pool, and the receipt.",
  alternates: { canonical: "/docs/desk" },
};

export default function DeskDocsPage() {
  return (
    <DocsLayout
      title="How the desk works"
      lede="What happens to a request from the moment you ask to the receipt, who sees what at each step, and what each part is trusted with."
    >
      <h2 id="the-parts">The parts</h2>
      <table>
        <thead>
          <tr>
            <th>Part</th>
            <th>Where it runs</th>
            <th>Its job</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>You</td>
            <td>Your browser, or an agent&apos;s process</td>
            <td>Builds and seals the request, proves your leg, holds your keys</td>
          </tr>
          <tr>
            <td>Desk</td>
            <td>
              <code>desk.hushd.testnet</code>
            </td>
            <td>Request commitments, the maker registry and bonds, deals and receipts</td>
          </tr>
          <tr>
            <td>Matcher</td>
            <td>An OutLayer project in a TEE</td>
            <td>Opens the request and the quotes, picks the best one, signs the match</td>
          </tr>
          <tr>
            <td>Makers</td>
            <td>Agents with a NEAR account</td>
            <td>Quote, sign their consent, settle their leg</td>
          </tr>
          <tr>
            <td>Pool</td>
            <td>
              <code>pool.hushd.testnet</code>
            </td>
            <td>Checks both proofs and applies both legs in one call</td>
          </tr>
          <tr>
            <td>API and relayer</td>
            <td>
              <code>api.hushd.net</code>
            </td>
            <td>Carry sealed messages, send transactions from their own account</td>
          </tr>
        </tbody>
      </table>

      <FlowDiagram
        title="One deal"
        steps={[
          { n: "1", title: "Request", body: "Sealed to the enclave. The desk stores only its sha256 (open_rfq)." },
          { n: "2", title: "Ask", body: "Each maker gets the pair, the side and the size, sealed to it." },
          { n: "3", title: "Quotes", body: "Signed by each maker's quote key and sealed to the enclave." },
          { n: "4", title: "Match", body: "The enclave picks the best quote inside your limit; the desk records it." },
          { n: "5", title: "Settle", body: "Both legs proven, then applied together by settle_swap." },
          { n: "6", title: "Receipt", body: "The outcome and its evidence, on the deal record." },
        ]}
      />

      <h2 id="1-the-request">1. The request</h2>
      <p>
        Your request says which package you want, what you sell and how much, what you buy and the least you accept of
        it (your limit), how long a quote must hold once matched, and, for a hedged package, which Hyperliquid perp to
        use. It also carries your <code>hushd1</code> address, the note a slashed bond would be paid to, and a public
        key made for this deal alone (the owner key, which closes a hedge). If you used the intake, your words are in
        it too.
      </p>
      <p>
        The request is sealed to the matcher&apos;s X25519 key, which the desk fetched from the enclave through
        OutLayer. The relayer then calls <code>open_rfq</code> on the desk with the sha256 of the sealed box and the
        quote window. The API stores the sealed box only after checking that its hash is the one committed on chain,
        and it cannot open it.
      </p>

      <h2 id="2-what-makers-see">2. What makers see</h2>
      <p>
        Each active maker gets its own copy of the ask, sealed to its key: the package kind, the token and amount you
        sell, the token you want, and the hedge coin. Never your limit, your address or your words: nothing in the ask
        says whose request it is.
      </p>

      <h2 id="3-quotes-and-the-match">3. Quotes and the match</h2>
      <p>
        A maker that wants the trade prices it and signs its consent to the exact terms with its quote key: the
        request id, the hash of the terms, the bond it puts up and the quote&apos;s expiry. It seals the signed quote
        to the enclave and posts it. Nobody but the enclave can read it, other makers included.
      </p>
      <p>When the window closes, the matcher client hands the enclave the sealed request and every sealed quote. The enclave:</p>
      <ol>
        <li>opens the request and checks it is the one committed on chain,</li>
        <li>opens each quote and drops any the maker did not really sign,</li>
        <li>keeps the quotes for this exact pair and size that meet your limit and are still valid,</li>
        <li>picks the one that gives you the most, and</li>
        <li>returns a match signed with its own key, with the agreed terms sealed to you and to the winning maker.</li>
      </ol>
      <p>
        Losing quotes and your limit never leave the enclave. The desk accepts a match only from OutLayer&apos;s
        on-chain callback (yield and resume) or signed by the enclave&apos;s key. It then checks the maker signed
        these terms with its registered quote key, is active, and has enough free bond, and records the deal: its
        maker, settlement class, terms hash, expiry and bond. The amounts are not in it.
      </p>

      <h2 id="4-settlement">4. Settlement</h2>
      <p>Both sides settle the spot leg the same way, through a sealed deal room on the API:</p>
      <ol>
        <li>Each side picks its notes and makes two outputs: a note for the other side, and its own change.</li>
        <li>
          Each sends the other its two output commitments and the opening of the note it made for them, sealed to
          them.
        </li>
        <li>
          Each checks the note it was sent opens to the agreed token and amount under its own receive key, and that it
          is the output the other side committed to.
        </li>
        <li>
          Each proves its own leg, bound to the deal id and all four outputs. Neither leg can be replayed alone or
          paired with another.
        </li>
        <li>
          Each signs <code>hushd.settle.v1:&lt;desk&gt;:&lt;deal id&gt;:&lt;the four outputs&gt;</code>: the trader with the
          deal&apos;s owner key, the maker with its quote key. A proof only says a leg belongs to this deal, and anyone can
          prove empty legs; the two signatures say both parties agreed to exactly these outputs.
        </li>
        <li>
          The maker submits both legs and both signatures through the relayer to <code>desk.settle</code>, which checks
          the signatures, and the desk calls{" "}
          <code>pool.settle_swap</code>: both proofs and both bindings are checked, and all four spends and four new
          notes are applied in one receipt. Both happen or neither does.
        </li>
      </ol>
      <p>
        The relayer checks both proofs and both signatures off chain, and that every note is unspent, before it sends
        anything. A bad
        submission does not end the deal: the two sides can try again until it expires.
      </p>

      <h2 id="5-the-receipt">5. The receipt</h2>
      <p>
        Every deal ends with a receipt on the desk, graded by its evidence. A spot deal is <strong>settled</strong>{" "}
        once the pool applies it, with the pool&apos;s leaf index and root as evidence. A hedged deal stays{" "}
        <strong>unresolved</strong> until its hedge leg is done: <strong>settled</strong> with the Hyperliquid fill,
        or <strong>recovered</strong> when a missed hedge pays the bond to you. A deal nobody settles before its expiry
        is marked <strong>failed</strong>, and its bond is released. See <Link href="/docs/packages">packages</Link>.
      </p>

      <h2 id="plain-language-intake">Plain-language intake</h2>
      <p>
        On the desk you can describe a deal in your own words. A model on NEAR AI Cloud turns them into a draft
        request, and the draft fills the form for you to check.
      </p>
      <ul>
        <li>
          The API fetches the model&apos;s attestation and verifies it with <code>@nearai/inference-sdk</code>: an
          Intel TDX quote and NVIDIA GPU evidence. The browser gets the model&apos;s signing key from that attestation.
        </li>
        <li>
          Your browser encrypts the instructions and your words to that key (X25519 from its ed25519 key, HKDF-SHA256,
          XChaCha20-Poly1305). The API only adds its API key, and neither it nor the NEAR AI gateway can read the text.
        </li>
        <li>
          The answer comes back encrypted to a one-time key in your browser, which then checks the TEE&apos;s ed25519
          signature over the exact request and response.
        </li>
      </ul>
      <p>
        You can check a model&apos;s attestation yourself at{" "}
        <a href="https://cloud.near.ai/verify" target="_blank" rel="noreferrer">
          cloud.near.ai/verify
        </a>
        . If the API has no NEAR AI key, the intake is off and the form works as usual.
      </p>
      <Callout title="The model only drafts">
        It never sees your balance and cannot send anything. You check every number in the form before the request is
        sealed.
      </Callout>

      <h2 id="who-can-do-what">Who can do what</h2>
      <table>
        <thead>
          <tr>
            <th>Who</th>
            <th>Can</th>
            <th>Cannot</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>API</td>
            <td>Store and hand out sealed boxes, refuse a request</td>
            <td>Open a request, a quote or a deal room message</td>
          </tr>
          <tr>
            <td>Relayer</td>
            <td>Send or refuse an action</td>
            <td>Change a proven action, or spend a note</td>
          </tr>
          <tr>
            <td>Matcher client</td>
            <td>Carry the batch to the enclave, delay it</td>
            <td>Read it, or forge a match</td>
          </tr>
          <tr>
            <td>Maker</td>
            <td>Quote, decline, fail to settle (and lose the deal)</td>
            <td>Learn your limit or your account</td>
          </tr>
          <tr>
            <td>Enclave</td>
            <td>Read requests and quotes, pick the match</td>
            <td>Spend anyone&apos;s notes</td>
          </tr>
        </tbody>
      </table>
      <p>
        What that rests on, and what it does not cover, is in <Link href="/docs/threat-model">the threat model</Link>.
      </p>
    </DocsLayout>
  );
}
