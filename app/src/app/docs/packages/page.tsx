import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, Code, FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Packages and settlement",
  description:
    "Hushd packages: spot settled atomically in the pool, and the experimental spot + hedge and cash and carry, where the maker bonds a Hyperliquid testnet hedge order it places for its own account, signed by NEAR Chain Signatures. Settlement classes, bonds, slashing and receipts.",
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
        { label: "Hedge leg", value: "Experimental, the maker's, bonded" },
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
            <td>The swap, plus a bonded hedge order the maker places for its own account (experimental)</td>
            <td>
              <Code>bonded_hedge</Code>
            </td>
          </tr>
          <tr>
            <td>Cash and carry</td>
            <td>Buy with a stablecoin, plus the same bonded hedge order (experimental)</td>
            <td>
              <Code>bonded_hedge</Code>
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        You pick the package on the <AppLink href="/app">desk</AppLink>, or the intake picks it from your words:
        asking for a hedge (&ldquo;hedge it&rdquo;) picks spot + hedge, and buying an asset with a stablecoin along
        with a short of its perp is cash and carry. Only tokens with a Hyperliquid perp can be hedged: wNEAR (NEAR) and
        BTC. A hedged package needs a maker bond of at least 1,000 USDC, so it makes sense from about 10,000 USDC of
        notional (see <Link href="#bonds-and-slashing">bonds</Link>).
      </p>
      <Callout tone="caveat" title="Hedged packages are experimental">
        On a hedged package you receive the spot leg, as on a spot deal. The hedge order trades for the maker&apos;s
        own Hyperliquid account, so the position and its profit or loss are the maker&apos;s: the package does not
        hedge you. What it adds for you is the maker&apos;s promise, backed by its bond, to place that order in time,
        and the bond itself, paid to you privately, if the order misses. No hedge has filled on testnet yet: the
        reference makers quote a hedged package only when their Hyperliquid testnet account holds the margin for it,
        and none does yet.
      </Callout>

      <h2 id="spot">Spot</h2>
      <p>
        You give one token and get another. Each side proves its own leg, and the pool applies both legs in one call,{" "}
        <code>settle_swap</code>: four notes spent and four made, or nothing at all. There is no escrow and no moment
        when one side has paid and the other has not, so a spot deal needs no bond.
      </p>
      <p>
        The maker submits both legs, after you have handed it yours, so it has a last look: it can wait until the deal
        expires and settle only if the price still suits it, at no cost on a spot deal. See{" "}
        <Link href="/docs/desk#last-look">last look</Link>.
      </p>
      <p>
        The receipt says <strong>settled</strong>, with the pool&apos;s leaf index and the new root as evidence.
      </p>

      <h2 id="spot-and-hedge">Spot and hedge</h2>
      <p>
        The spot leg settles exactly as above, and you hold what you bought. Then the maker&apos;s hedge order goes to
        Hyperliquid testnet: a short of the perp for the size the maker gave you, immediate or cancel, at the limit in
        the deal record. NEAR Chain Signatures (<code>v1.signer-prod.testnet</code>) sign it from an address derived
        from the path <code>hushd/hedge/&lt;deal id&gt;</code>.
      </p>
      <p>
        That address holds no margin of its own. The maker&apos;s Hyperliquid account approves it as an agent, so the
        order trades for the maker&apos;s account: the position, its margin and its profit or loss are the
        maker&apos;s, not yours. Hyperliquid books an agent&apos;s orders on the account that approved it, so all of
        one maker&apos;s hedges show on that maker&apos;s account there, whatever address signed them.
      </p>
      <FlowDiagram
        title="The hedge leg"
        steps={[
          { n: "1", title: "Spot settles", body: "You hold what you bought. The deal moves to hedge pending; its receipt reads unresolved." },
          { n: "2", title: "The desk has the order signed", body: "It rebuilds the order from the deal and asks the MPC to sign it for the deal's path." },
          { n: "3", title: "The keeper submits it", body: "To Hyperliquid testnet, where it trades for the maker's account, then reports the fill or the miss to the desk." },
          { n: "4", title: "Settled or recovered", body: "A fill releases the maker's bond. A miss can be signed again, up to three orders in all; if none fills in time, the bond is paid to you." },
        ]}
      />
      <p>
        The keeper cannot change the order: the desk rebuilds it from the deal record (immediate or cancel, the
        package&apos;s side, size and limit price, the block time as nonce). The keeper or the deal&apos;s maker asks
        for it with <code>sign_hedge_order</code>, and only one opening order is out at a time. When the keeper reports
        that an order did not fill and the deadline has not passed, the order can be signed again, up to three opening
        orders per deal.
      </p>
      <p>
        The keeper alone reports how the order went, and the desk releases or slashes the bond on that report
        (<code>record_hedge</code>). So the outcome rests on the keeper: a false fill would release the bond, and a
        false miss would pay it to you. If the keeper reports nothing, anyone may slash the bond once the deadline has
        passed (<code>slash_overdue</code>).
      </p>

      <h2 id="cash-and-carry">Cash and carry</h2>
      <p>
        You buy the asset with a stablecoin, and the maker commits to the same bonded hedge order: a short of its perp
        for the size you bought, placed for the maker&apos;s own account. You hold the asset; the short is not yours.
        It settles the same way as spot + hedge, with the same bond, the same receipt and the same experimental
        status.
      </p>

      <h2 id="bonds-and-slashing">Bonds and slashing</h2>
      <p>
        A maker posts a bond in the desk&apos;s bond token (test USDC) before it can quote hedged packages, and each
        hedged quote says how much of that bond it puts on the deal. The desk locks that much when the deal is
        matched, and accepts the match only if the maker&apos;s free bond covers it.
      </p>
      <p>
        The desk&apos;s <code>min_bond</code> is 1,000 USDC: a hedged quote must bond at least that much, so hedged
        packages make sense from about 10,000 USDC of notional. Bonds come only in steps of <code>min_bond</code> (1, 2,
        5, 10, 20, 50 and so on times it), so a public bond does not give a trade&apos;s size away; the reference makers
        bond a tenth of the trade&apos;s value, rounded up to the next step.
      </p>
      <ul>
        <li>
          <strong>The hedge fills.</strong> On the keeper&apos;s report, the bond is released and the receipt says
          settled, with the fill as evidence.
        </li>
        <li>
          <strong>The hedge does not fill.</strong> The keeper records each miss. Before the deadline the order is
          signed again, up to three opening orders in all; the third miss, or a miss after the deadline, slashes the
          bond. Once the deadline has passed with no fill recorded, anyone may call <code>slash_overdue</code>. Either
          way the desk pays the bond into the pool as a private note to you, made from the payout key in your request,
          and the receipt says <strong>recovered</strong>. Your wallet watches for that note and adds it to your balance
          when it lands.
        </li>
        <li>
          <strong>The pool cannot take the payout.</strong> The desk holds the bond for you and the receipt says
          unresolved. Anyone may call <code>retry_slash_payout</code> to send it to the pool again, as the same note
          for you.
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
        ask for the hedge to be closed: you sign <code>hushd.close:&lt;desk account&gt;:&lt;deal id&gt;</code> (for
        example <code>hushd.close:desk.hushd.testnet:42</code>), the relayer sends it to <code>close_hedge</code>, the
        desk checks the signature, and the MPC signs a reduce-only order the other way. That order trades for the
        maker&apos;s account too: it closes the maker&apos;s hedge position and pays you nothing. You can close once,
        after the deal has settled, from the deal&apos;s page in <AppLink href="/app/deals">Deals</AppLink>.
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
            <td>Spot applied; for a hedged deal, the keeper reported the hedge filled too</td>
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
