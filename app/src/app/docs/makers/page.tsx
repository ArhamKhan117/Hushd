import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout, FlowDiagram } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Makers",
  description:
    "Makers on Hushd: agents that quote sealed requests, sign their consent with a quote key, bond hedged deals and settle their leg in the pool. How the reference makers price, and how to run your own.",
  alternates: { canonical: "/docs/makers" },
};

export default function MakersDocsPage() {
  return (
    <DocsLayout
      title="Makers"
      lede="The agents on the other side of every deal. What a maker is, how the reference makers price, and how to run one."
      glance={[
        { label: "Identity", value: "A NEAR account" },
        { label: "Signs with", value: "Its quote key" },
        { label: "Bonds", value: "Test USDC" },
      ]}
    >
      <h2 id="what-a-maker-is">What a maker is</h2>
      <p>
        A maker is an agent with a NEAR account, registered on the desk. It quotes the requests sealed to it, gives
        from its own private balance, and settles its leg of each deal it wins. Unlike traders, makers are public,
        like any market maker: the desk lists each one&apos;s name, pricing style, bond, deals and slashed amount.
        See them in <AppLink href="/app/makers">Makers</AppLink>.
      </p>
      <p>A maker holds four things:</p>
      <ul>
        <li>a NEAR account, which registers it and posts its bond,</li>
        <li>
          a Hushd seed, behind its private balance and its X25519 key (the key asks are sealed to),
        </li>
        <li>a quote key (ed25519), whose signature on a quote is its consent to those exact terms, and</li>
        <li>a bond in test USDC, which backs the hedge leg of the deals it wins.</li>
      </ul>

      <h2 id="the-reference-makers">The reference makers</h2>
      <p>
        Hushd runs three makers in <code>services/src/makers.ts</code>, so the desk always has someone to trade with.
        They differ only in how they set the spread:
      </p>
      <table>
        <thead>
          <tr>
            <th>Style</th>
            <th>Spread</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>fixed</code>
            </td>
            <td>25 basis points on every quote</td>
          </tr>
          <tr>
            <td>
              <code>volatility</code>
            </td>
            <td>10 plus 0.6 times the last hour&apos;s realized volatility, in basis points, held between 15 and 150</td>
          </tr>
          <tr>
            <td>
              <code>inventory</code>
            </td>
            <td>15 basis points when it holds plenty of what it gives, widening to 75 as that runs low</td>
          </tr>
        </tbody>
      </table>

      <h2 id="pricing">Pricing</h2>
      <p>
        The reference makers price from Hyperliquid mid prices (public market data), with USDC at one dollar. They
        take a dry NEAR Intents (1Click) quote for the same trade as a second reference, and never quote better than
        that market less their spread. A maker you run can price from anything you like.
      </p>
      <p>
        They quote only what they can fill from their own private balance, and each quote holds for five minutes. For
        a hedged package they add the hedge: a short of the perp for the size they give, as an immediate-or-cancel
        order with a limit of 99% of the mid, a ten-minute deadline, and a bond of a tenth of the trade&apos;s value,
        rounded up to one of a few fixed steps and never less than the desk&apos;s <code>min_bond</code> (1,000 USDC).
      </p>

      <h2 id="quoting">Quoting</h2>
      <FlowDiagram
        title="Every two seconds"
        steps={[
          { n: "1", title: "Read the asks", body: "Fetch the open asks sealed to this maker from the API, and open them." },
          { n: "2", title: "Price and sign", body: "Price the ask, then sign the terms, the bond and the expiry with the quote key." },
          { n: "3", title: "Seal and post", body: "Seal the signed quote to the enclave and post it before the window closes." },
          { n: "4", title: "Settle the wins", body: "Open the result sealed to it, and settle its leg of each deal it won." },
        ]}
      />
      <p>
        The ask holds the package kind, the token and amount being sold, the token wanted and the hedge coin. It never
        holds the trader&apos;s limit or address. What the quote key (ed25519) signs is its consent to one exact deal on
        one desk:
      </p>
      <pre>
        <code className="language-text">{`"hushd.quote.v2"
‖ desk account id   (u32 LE length ‖ utf8)
‖ rfq id            (u64 LE)
‖ terms hash        (32 bytes)
‖ bond              (u128 LE)
‖ expires at, ms    (u64 LE)
‖ class             (u8: 0 atomic_pool, 1 bonded_hedge, 2 atomic_intents)
‖ hedge hash        (32 bytes: sha256 of the borsh HedgeSpec, or zeros)
‖ maker account id  (u32 LE length ‖ utf8)`}</code>
      </pre>
      <p>
        The desk rebuilds these bytes from the match itself and checks the signature against the key the maker
        registered before it records a deal, so a matcher cannot attach a class, a hedge or a maker the maker did not
        sign. In the protocol package the same bytes are <code>consentBytes</code>.
      </p>

      <h2 id="settling-the-leg">Settling the leg</h2>
      <p>
        The maker is always online, so it is the one that submits. It waits for the trader&apos;s plan, checks the note
        made for it opens to the agreed amount, makes its own two outputs and sends the trader the opening of the one
        meant for them, proves its leg, waits for the trader&apos;s proven leg, and sends both through the relayer to{" "}
        <code>desk.settle</code>. In the SDK this is one call, <code>settleAsMaker</code>. How the two legs are bound
        together is in <Link href="/docs/desk#4-settlement">how the desk works</Link>.
      </p>

      <h2 id="bonds">Bonds</h2>
      <ul>
        <li>
          <strong>Post</strong>: send test USDC to <code>desk.hushd.testnet</code> with <code>ft_transfer_call</code>{" "}
          and the message <code>bond</code>. Only a registered maker can post.
        </li>
        <li>
          <strong>Lock</strong>: each hedged deal locks the bond its quote named. The desk refuses a match the free
          bond cannot cover.
        </li>
        <li>
          <strong>Release or slash</strong>: a filled hedge releases it, and a missed one pays it to the trader as a
          private note. See <Link href="/docs/packages#bonds-and-slashing">bonds and slashing</Link>.
        </li>
        <li>
          <strong>Withdraw</strong>: <code>withdraw_bond</code> returns any part of the free bond.
        </li>
      </ul>

      <h2 id="run-one">Run one</h2>
      <ol>
        <li>Create a NEAR testnet account for the maker and give it a little testnet NEAR.</li>
        <li>
          Make a 32-byte seed (its private wallet) and an ed25519 quote key (a 32-byte secret), both as hex, and keep
          both secret.
        </li>
        <li>
          For hedged packages, give it a Hyperliquid testnet account. Its key approves each hedged deal&apos;s own
          address to trade on the maker&apos;s margin.
        </li>
        <li>
          Start the makers service with them. On start, each maker registers itself on the desk with{" "}
          <code>register_maker</code> (name, X25519 key, quote URL, style, quote key), or updates its keys.
        </li>
        <li>Give it inventory: add test tokens to its private balance, or pay its hushd1… address.</li>
        <li>
          Post a bond if it should quote hedged packages: at least the desk&apos;s <code>min_bond</code> (1,000 USDC).
        </li>
      </ol>
      <p>
        In a checkout of the repo, put the maker&apos;s settings in the repo&apos;s <code>.env</code>. The services read
        that file themselves, and every variable is listed in <code>.env.example</code>.
      </p>
      <pre>
        <code className="language-text">{`MAKER_A_ACCOUNT=your-maker.testnet
MAKER_A_PRIVATE_KEY=ed25519:…   # the account's key
MAKER_A_SEED=…                  # 32 bytes hex: the maker's private wallet
MAKER_A_QUOTE_KEY=…             # its ed25519 quote key: the secret, 32 bytes hex
MAKER_A_HL_KEY=0x…              # optional: its Hyperliquid testnet key, for hedged deals
MAKERS_PUBLIC_URL=https://makers.example.com
RELAYER_URL=https://api.hushd.net
API_URL=https://api.hushd.net`}</code>
      </pre>
      <p>
        <code>MAKERS_PUBLIC_URL</code> is where others reach this service: each maker registers{" "}
        <code>&lt;MAKERS_PUBLIC_URL&gt;/makers/&lt;account&gt;/quote</code> as its quote URL. The service runs up to
        three makers (<code>MAKER_A</code>, <code>MAKER_B</code>, <code>MAKER_C</code>) with the three styles above, and
        keeps their notes in an encrypted file. Then start it:
      </p>
      <pre>
        <code className="language-bash">{`pnpm stack                                   # the easy way: every service, behind one gateway
pnpm --filter @hushd/services start makers   # or the makers alone`}</code>
      </pre>
      <p>
        <code>pnpm stack</code> runs every service whose keys are in <code>.env</code> behind one gateway on{" "}
        <code>localhost:8080</code>, routed like the production Caddyfile. <code>deploy/docker-compose.yml</code> runs
        the same services from the same <code>.env</code> file.
      </p>
      <Callout title="A maker of your own">
        Pricing, inventory and risk are yours to change. Keep the protocol: open only asks sealed to you, sign the
        exact terms with your registered quote key, seal the quote to the enclave key the desk publishes, and settle
        with <code>settleAsMaker</code>.
      </Callout>

      <h2 id="selling-quotes-over-x402">Selling quotes over x402</h2>
      <p>
        Each reference maker also sells indicative quotes at <code>/makers/&lt;account&gt;/quote</code> on the API,
        priced by <code>X402_QUOTE_PRICE</code> in USDC base units (10000, or 0.01 test USDC, by default) and paid by{" "}
        <Link href="/docs/x402">private x402</Link> to the maker&apos;s own hushd1… address. A paid request returns
        what the maker would give for that size right now, valid for 30 seconds. Payments already used are kept on
        disk, so a restart cannot replay them.
      </p>
    </DocsLayout>
  );
}
