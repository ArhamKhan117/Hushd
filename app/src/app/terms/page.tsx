import type { Metadata } from "next";
import Link from "next/link";
import { LegalLayout } from "@/components/LegalLayout";

export const metadata: Metadata = {
  title: "Terms of use",
  description:
    "The terms for using Hushd: experimental open-source software on NEAR testnet, test tokens with no value, no custody of your funds, and no warranty.",
  alternates: { canonical: "/terms" },
};

const ISSUES = "https://github.com/ArhamKhan117/Hushd/issues";

export default function TermsPage() {
  return (
    <LegalLayout
      title="Terms of use"
      updated="6 November 2026"
      lede="Short and plain: Hushd is experimental software on a test network. Use it to try things, not to move anything of value."
    >
      <h2>What Hushd is</h2>
      <p>
        Hushd is open-source software for a private over-the-counter desk on NEAR, run by Arham Khan at hushd.net. It
        includes the website and app, the Hushd API at api.hushd.net, the hosted MCP server at hushd.net/mcp, and the
        contracts, services and packages in its{" "}
        <a href="https://github.com/ArhamKhan117/Hushd" target="_blank" rel="noreferrer">
          public repository
        </a>
        . By using any of them you accept these terms.
      </p>

      <h2>Testnet only</h2>
      <ul>
        <li>Every Hushd contract runs on NEAR testnet. The hedge leg trades on Hyperliquid testnet.</li>
        <li>The tokens Hushd lists are test tokens from a faucet. They have no value and cannot be redeemed for anything.</li>
        <li>Do not send real assets to any Hushd account. There are no Hushd contracts on mainnet.</li>
      </ul>

      <h2>Experimental software</h2>
      <p>
        Hushd uses development proving keys, not keys from a multi-party ceremony, and it has not been audited. It may
        have bugs, be unavailable, change, be reset, or stop at any time, with or without notice. Testnet balances and
        records may be lost when that happens. Read <Link href="/docs/threat-model">the threat model</Link> for what can
        go wrong.
      </p>

      <h2>Your keys, your notes</h2>
      <p>
        Hushd never holds your funds. Only your keys can spend your notes: the relayer can refuse to send an action, but
        it cannot move funds or change what you proved, and nobody running Hushd can spend for you. That also means
        nobody can recover a lost seed for you. Keep the wallet key or passkey that opens your private balance.
      </p>

      <h2>Not advice</h2>
      <p>
        Nothing on Hushd is investment, legal or tax advice. Quotes come from independent makers. The intake model only
        drafts a request from your words, and you are responsible for checking every number before you ask the desk.
      </p>

      <h2>Agents and makers</h2>
      <ul>
        <li>
          If you run an agent with the Hushd MCP server, you are responsible for what it does and for the spending
          limits you give it.
        </li>
        <li>
          Makers other than the reference makers are run by others. Hushd does not vouch for them, beyond what the desk
          contract enforces.
        </li>
      </ul>

      <h2>Fair use</h2>
      <ul>
        <li>Do not use Hushd to break the law, or to harm anyone.</li>
        <li>
          Do not overload the faucet, the relayer or the API, or try to get around their limits. They are shared by
          everyone testing.
        </li>
        <li>
          Look for security problems only within the rules on <Link href="/security">security</Link>, and report them
          there.
        </li>
      </ul>

      <h2>The software license</h2>
      <p>
        The code is released under the MIT license, which lets you use, copy, change and share it. These terms cover
        the services run at hushd.net and api.hushd.net, not copies you run yourself.
      </p>

      <h2>No warranty</h2>
      <p>
        Hushd is provided as is, without warranty of any kind. To the fullest extent the law allows, nobody who builds
        or runs Hushd is liable for any loss that comes from using it, including lost test tokens, lost data, or a
        service that is down.
      </p>

      <h2>Changes and contact</h2>
      <p>
        These terms may change; the date at the top says when they last did, and the history is public in the
        repository. For questions, open an issue on{" "}
        <a href={ISSUES} target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </p>
    </LegalLayout>
  );
}
