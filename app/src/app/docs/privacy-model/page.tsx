import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, SeenBy } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Privacy model",
  description:
    "Exactly what Hushd keeps private and what stays public: deposits and cash outs with their amounts are public, desk deals and their outcomes are public, amounts and parties inside the pool are private. What can leak, and who you trust.",
  alternates: { canonical: "/docs/privacy-model" },
};

const ROWS: [string, string][] = [
  ["A deposit: your NEAR account, the token and the amount", "Anyone"],
  ["A cash out: the receiving account, the token and the amount", "Anyone"],
  ["That a private transfer happened: a pool call from the relayer with two new notes", "Anyone"],
  ["Who paid whom inside the pool, and how much", "The two sides only"],
  ["Your private balance", "You only"],
  ["A claim link, and so its amount and the right to claim it", "Whoever holds the link"],
  ["Your request: your limit, your address, your words", "You and the matcher enclave"],
  ["The ask: the package kind, the pair, the side and the size", "Each registered maker"],
  ["Quotes, including the ones that lose", "The maker that made each, and the enclave"],
  ["That a deal happened: its maker, class, expiry, bond, outcome and evidence", "Anyone"],
  ["A hedge order: the coin, the side, the size and the limit", "Anyone, on the desk and on Hyperliquid"],
  ["The agreed amounts, and who the trader was", "The trader and the winning maker"],
  ["That a deal room message was sent: its deal, size and time, and the key it is sealed to", "The API, until the deal settles or closes, and a day at most"],
  ["Your words to the intake", "You and the attested model"],
  ["The fact a proof shows", "Whoever holds the proof"],
];

export default function PrivacyModelPage() {
  return (
    <DocsLayout
      title="Privacy model"
      lede="Hushd hides who traded and how much. It does not hide that money entered or left the pool, or that a deal happened. Here is the whole picture, including what can leak."
    >
      <SeenBy
        title="At a glance"
        open={[
          "Deposits and cash outs, with their amounts",
          "That a desk deal happened, and how it ended",
          "Makers, their bonds and their hedge orders",
          "How many notes, transfers and deals there are",
        ]}
        sealed={[
          "Amounts and parties inside the pool",
          "Your balance",
          "Your limit and your words",
          "Who the trader on a deal was",
        ]}
      />

      <h2 id="who-sees-what">Who sees what</h2>
      <table>
        <thead>
          <tr>
            <th>What</th>
            <th>Who can see it</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([what, who]) => (
            <tr key={what}>
              <td>{what}</td>
              <td>{who}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 id="what-is-public">What is public, and why</h2>
      <p>
        <strong>Deposits and cash outs.</strong> Tokens move between a NEAR account and the pool, so the token
        contract records the transfer like any other: the account, the token and the amount. That is the boundary of
        the private balance.
      </p>
      <p>
        <strong>Desk deals.</strong> A deal is a public record on the desk, so that both sides, and anyone else, can
        see it was matched by the enclave, settled by the pool and closed with a receipt. The record holds the maker,
        the settlement class, a hash of the terms, the expiry, the bond and the outcome with its evidence. It does not
        hold the amounts or the trader.
      </p>
      <p>
        <strong>Hedges.</strong> A hedged deal carries its Hyperliquid order in the deal record, because the desk
        rebuilds and signs that exact order. The order is public on Hyperliquid too. It is signed from an address
        derived for that deal, but that address trades for the maker&apos;s own Hyperliquid account, so all of one
        maker&apos;s hedges show together on that account.
      </p>
      <p>
        <strong>Makers.</strong> Makers are public, like any market maker: their account, name, style, bond, deal
        count and anything slashed.
      </p>

      <h2 id="what-is-private">What is private</h2>
      <p>
        Inside the pool, a note is a Poseidon commitment to an owner, an amount and a token. Spending one reveals a
        nullifier, which cannot be linked to the note it spends without the owner&apos;s key. A private transfer
        shows two new commitments and two nullifiers, sent by the relayer: not the sender, the recipient or the amount.
        A desk settlement shows four of each, the same way.
      </p>
      <p>
        Word of a payment goes on the board as a ciphertext sealed to the recipient. The board never records who
        posted, and every recipient reads every post and keeps what opens for it, so nobody learns who a post is for.
      </p>

      <h2 id="screening">Sanctions screening</h2>
      <p>
        Hushd screens public addresses only: the NEAR account a deposit comes from, the NEAR account a cash out pays,
        and the address on another chain that a deposit or a cash out through NEAR Intents uses. It never screens a
        note, a hushd1… address or an amount.
      </p>
      <p>
        The list is a dated snapshot of the digital currency addresses on OFAC&apos;s SDN list, kept in the SDK as
        hashes and rebuilt from OFAC&apos;s own file by a script. The app checks before you sign, so the check needs
        nothing from a server; the API answers <code>POST /v1/screen</code> for agents and other clients; and the
        relayer checks a cash out&apos;s recipient again before it sends it. A listed address sees one line,
        &ldquo;This address can&apos;t be used with Hushd.&rdquo;, and nothing else.
      </p>

      <h2 id="claim-links">Claim links</h2>
      <p>
        Paying as a link pays a one-time note and puts what opens it in the link itself, after the <code>#</code>.
        Browsers never send that part to a server, so neither the app nor the API sees it. On chain, paying into a link
        and claiming it are two private transfers sent by the relayer, like any other.
      </p>
      <p>
        The link is the payment: whoever opens it first can claim it, so share it the way you would share cash.
        Claiming moves it into a new note made in the claimer&apos;s browser for their own key, so once it is claimed
        the payer cannot take it back. Until then, the payer can. Anyone who opens a spent link sees only that it was
        already claimed, not by whom or whether it was taken back.
      </p>

      <h2 id="what-can-leak">What can leak</h2>
      <ul>
        <li>
          <strong>Timing and amounts.</strong> A deposit of an odd amount followed soon after by a cash out of the same
          amount links the two, whatever happened in between. Waiting, and moving round amounts, helps.
        </li>
        <li>
          <strong>A small crowd.</strong> On testnet, few people use the pool, so the set of notes you hide among is
          small.
        </li>
        <li>
          <strong>A hedged deal&apos;s size.</strong> The desk takes a bond only in fixed steps (its minimum times 1, 2,
          5, 10, 20, 50 and so on), so a public bond says only which step the trade falls in. The hedge order is
          different: it runs on Hyperliquid, a public venue, so its size is in the deal record and on Hyperliquid. A
          spot deal has neither a bond nor a hedge. On Hyperliquid, every hedge a maker places shows on that
          maker&apos;s account, whichever per-deal address signed it.
        </li>
        <li>
          <strong>Your receive address.</strong> The winning maker learns your hushd1… address, since it makes a note
          for you. Deals with the same maker from the same address can be linked by that maker.
        </li>
        <li>
          <strong>Deal rooms.</strong> The two sides of a deal swap sealed messages through the API. It files the
          maker&apos;s under the maker&apos;s public key, and the trader&apos;s under a key the trader&apos;s wallet
          made for that deal alone, so nothing it holds says which deals a hushd1… address took part in. It sees each
          message&apos;s deal, size and time, and deletes a room once its deal settles or closes on the desk, and any
          message after a day.
        </li>
        <li>
          <strong>Request metadata.</strong> The API and the relayer see the network side of your requests: when they
          arrive and from which IP address. Use a VPN or Tor if that matters to you.
        </li>
        <li>
          <strong>Proofs you share.</strong> A proof can be forwarded. It says who it was made for, but whoever holds
          it learns the fact it shows, and for a deal leg, which deal it was.
        </li>
      </ul>

      <h2 id="who-you-trust">Who you trust, and with what</h2>
      <table>
        <thead>
          <tr>
            <th>Who</th>
            <th>Trusted with</th>
            <th>Never trusted with</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>The relayer</td>
            <td>Sending your actions, and not logging their metadata</td>
            <td>Your keys, your notes, or what a proof binds (recipient, fee, refund note)</td>
          </tr>
          <tr>
            <td>The matcher enclave</td>
            <td>Keeping your request, your limit and the quotes private, and picking the best quote (your client refuses one below your limit)</td>
            <td>Your notes: it never sees a spending key</td>
          </tr>
          <tr>
            <td>The intake model</td>
            <td>Keeping your words private inside its TEE</td>
            <td>Anything that moves money: it only drafts</td>
          </tr>
          <tr>
            <td>The API</td>
            <td>Passing sealed messages on, deleting deal rooms once their deals are done, and not logging their metadata</td>
            <td>The content of any request, quote or deal room message, or which deals a hushd1… address took part in</td>
          </tr>
          <tr>
            <td>The matcher client</td>
            <td>Putting every sealed quote from the API&apos;s database into the enclave&apos;s batch: the enclave cannot tell if one is left out</td>
            <td>The content of a request or a quote, or forging a match</td>
          </tr>
          <tr>
            <td>The keeper</td>
            <td>Reporting truly whether a hedge order filled: the desk releases or slashes the maker&apos;s bond on its word</td>
            <td>Changing a hedge order, or moving a note</td>
          </tr>
          <tr>
            <td>The desk owner</td>
            <td>Proposing desk settings (the keeper, the pinned matcher build, the minimum bond), which apply only after a public one-day timelock</td>
            <td>Your notes, your deals&apos; terms, or a pool rule change without the pool&apos;s own timelock</td>
          </tr>
        </tbody>
      </table>
      <p>
        The enclave&apos;s privacy rests on the TEE it runs in: an Intel TDX worker on OutLayer running the matcher
        code the desk pins. The model&apos;s rests on NEAR AI Cloud&apos;s attested TEE. Both are stated in full in{" "}
        <Link href="/docs/threat-model">the threat model</Link>.
      </p>

      <h2 id="on-your-device">On your device</h2>
      <ul>
        <li>
          Your notes are kept in your browser&apos;s storage, encrypted with AES-GCM under a key from your seed. Every
          note you make for yourself is also on the board, sealed to you, so the seed alone recovers your balance.
        </li>
        <li>
          With a NEAR wallet, the seed is a signature your wallet makes again each time you open the balance. Nothing
          secret is stored.
        </li>
        <li>With a passkey, the seed comes from the passkey itself, and the browser remembers only which account it opens.</li>
        <li>
          Links you paid are kept only in that encrypted store, not on the board. If it is cleared, you can no longer
          take back an unclaimed link, though the link still works for whoever holds it.
        </li>
      </ul>
      <Callout title="Losing the seed loses the balance">
        Nobody else can spend your notes, so nobody else can recover them. Keep the wallet key or the passkey that
        opens your balance.
      </Callout>
    </DocsLayout>
  );
}
