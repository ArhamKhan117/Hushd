import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, Code, FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Packages and settlement",
  description:
    "Hushd packages: spot settled atomically in the pool, and spot + hedge or cash and carry with a Hyperliquid testnet perp signed by NEAR Chain Signatures and bonded by the maker. Settlement classes, bonds, slashing and receipts.",
  alternates: { canonical: "/docs/packages" },
};

export default function PackagesPage() {
  return (
    <DocsLayout
      title="Packages and settlement"
      lede="A deal on Hushd is a package: one request, quoted as a whole, settled and recorded as one. Here is what each package does, and what happens when a leg goes wrong."
      glance={[
        { label: "Packages", value: "Spot, spot + hedge, cash and carry" },
        { label: "Spot leg", value: "Atomic, in the pool" },
        { label: "Hedge leg", value: "Hyperliquid testnet, bonded" },
      ]}
    >
      <h2 id="the-three-packages">The three packages</h2>
      <table>
        <thead>
          <tr>
            <th>Package</th>
            <th>Legs</th>
            <th>Settlement class</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Spot</td>
            <td>One swap in the pool</td>
            <td>
              <Code>atomic_pool</Code>
            </td>
          </tr>
          <tr>
            <td>Spot + hedge</td>
            <td>The swap, plus a perp short of what you buy</td>
            <td>
              <Code>bonded_hedge</Code>
            </td>
          </tr>
          <tr>
            <td>Cash and carry</td>
            <td>Buy with a stablecoin, plus a perp short of the same size</td>
            <td>
              <Code>bonded_hedge</Code>
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        You pick the package on the <AppLink href="/app">desk</AppLink>, or the intake picks it from your words:
        &ldquo;hedge it&rdquo; or &ldquo;keep me neutral&rdquo; means spot + hedge, and buying an asset with a
        stablecoin while shorting its perp is cash and carry. Only tokens with a Hyperliquid perp can be hedged: wNEAR
        (NEAR) and BTC.
      </p>

      <h2 id="spot">Spot</h2>
      <p>
        You give one token and get another. Each side proves its own leg, and the pool applies both legs in one call,{" "}
        <code>settle_swap</code>: four notes spent and four made, or nothing at all. There is no escrow and no moment
        when one side has paid and the other has not, so a spot deal needs no bond.
      </p>
      <p>
        The receipt says <strong>settled</strong>, with the pool&apos;s leaf index and the new root as evidence.
      </p>

      <h2 id="spot-and-hedge">Spot and hedge</h2>
      <p>
        The spot leg settles exactly as above. Then the desk opens a short on Hyperliquid testnet of what you bought,
        so the package is flat on price. The order is placed from an address made for this deal alone: NEAR Chain
        Signatures (<code>v1.signer-prod.testnet</code>) derive it from the path{" "}
        <code>hushd/hedge/&lt;deal id&gt;</code>, so no two deals share a Hyperliquid address.
      </p>
      <FlowDiagram
        title="The hedge leg"
        steps={[
          { n: "1", title: "Spot settles", body: "The deal moves to hedge pending; its receipt reads unresolved." },
          { n: "2", title: "The desk has the order signed", body: "It rebuilds the order from the deal and asks the MPC to sign it for the deal's path." },
          { n: "3", title: "The keeper submits it", body: "To Hyperliquid testnet, then records the fill or the rejection on the desk." },
          { n: "4", title: "Settled or recovered", body: "A fill settles the deal. A miss pays you the maker's bond." },
        ]}
      />
      <p>
        The keeper cannot change the order: the desk rebuilds it from the deal record (immediate or cancel, the
        package&apos;s side, size and limit price, the block time as nonce) and allows one opening order per deal.
      </p>

      <h2 id="cash-and-carry">Cash and carry</h2>
      <p>
        You buy the asset with a stablecoin and the desk shorts its perp for the same size, so you hold the asset and
        the short together. It settles the same way as spot + hedge, with the same bond and the same receipt.
      </p>

      <h2 id="bonds-and-slashing">Bonds and slashing</h2>
      <p>
        A maker posts a bond in the desk&apos;s bond token (test USDC) before it can quote hedged packages, and each
        hedged quote says how much of that bond it puts on the deal. The desk locks that much when the deal is
        matched, and accepts the match only if the maker&apos;s free bond covers it. The reference makers bond a
        tenth of the trade&apos;s value.
      </p>
      <ul>
        <li>
          <strong>The hedge fills.</strong> The bond is released and the receipt says settled, with the fill as
          evidence.
        </li>
        <li>
          <strong>The hedge is rejected, or misses its deadline.</strong> The keeper records a rejection, and
          anyone may slash a deal past its deadline with nothing recorded. Either way the desk pays the bond into the pool as a private note to you, made from the payout key in your request, and the receipt says{" "}
          <strong>recovered</strong>. Your wallet watches for that note and adds it to your balance when it lands.
        </li>
        <li>
          <strong>The pool cannot take the payout.</strong> The desk keeps the bond and the receipt says unresolved.
        </li>
      </ul>
      <Callout tone="caveat" title="A bond is public">
        The bond amount is in the deal record. Since the reference makers size it from the trade, it hints at the
        deal&apos;s size. The hedge order itself (coin, side, size and limit) is in the deal record too, and on
        Hyperliquid.
      </Callout>

      <h2 id="closing-the-hedge">Closing the hedge</h2>
      <p>
        Your request carries a public key made for this deal alone, derived from your spending key. Only that key can
        close the hedge: you sign <code>hushd.close:&lt;deal id&gt;</code>, the relayer sends it to{" "}
        <code>close_hedge</code>, the desk checks the signature, and the MPC signs a reduce-only order the other way.
        You can close once, after the deal has settled, from the deal&apos;s page in{" "}
        <AppLink href="/app/deals">Deals</AppLink>.
      </p>

      <h2 id="receipts">Receipts</h2>
      <table>
        <thead>
          <tr>
            <th>Outcome</th>
            <th>When</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Settled</td>
            <td>Spot applied; for a hedged deal, the hedge filled too</td>
            <td>
              <Code>pool_settlement</Code>, <Code>pool_root</Code>, <Code>hyperliquid_fill</Code>
            </td>
          </tr>
          <tr>
            <td>Recovered</td>
            <td>The hedge missed and the bond was paid to you</td>
            <td>
              <Code>hyperliquid_reject</Code> or <Code>hedge_overdue</Code>, <Code>bond_paid_privately</Code>
            </td>
          </tr>
          <tr>
            <td>Failed</td>
            <td>Nobody settled before the deal expired</td>
            <td>
              <code>expired</code>
            </td>
          </tr>
          <tr>
            <td>Unresolved</td>
            <td>The hedge is still open, or a payout came back</td>
            <td>
              <Code>bond_payout_returned</Code>, or the evidence so far
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Receipts are public, like the deal record they belong to. The amounts are not in them. To show a receipt&apos;s
        amount to someone, <Link href="/docs/proofs">prove it to them</Link>.
      </p>
    </DocsLayout>
  );
}
