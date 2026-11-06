import type { Metadata } from "next";
import Link from "next/link";
import { LegalLayout } from "@/components/LegalLayout";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "How Hushd handles data: no accounts and no personal details collected, notes encrypted in your browser and sealed on the board, request metadata the API sees, intake text encrypted end to end to an attested model, and analytics only if you accept.",
  alternates: { canonical: "/privacy" },
};

const ISSUES = "https://github.com/ArhamKhan117/Hushd/issues";

export default function PrivacyPage() {
  return (
    <LegalLayout
      title="Privacy"
      updated="6 November 2026"
      lede="Hushd is built so that we learn as little as possible about you. This page says what that means in practice, including what we cannot keep private."
    >
      <h2>Who runs Hushd</h2>
      <p>
        Hushd is open-source software run by Arham Khan at hushd.net, on NEAR testnet. There is no company behind it.
        This page covers the website and app at hushd.net, the hosted MCP server at hushd.net/mcp, and the Hushd API
        at api.hushd.net. For anything about it, open an issue on{" "}
        <a href={ISSUES} target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </p>

      <h2>What we do not collect</h2>
      <ul>
        <li>There are no Hushd accounts. We never ask for your name, email or any other personal details.</li>
        <li>
          We never see your seed, your spending key or your notes. They are made and kept on your device, and nothing
          we run can spend for you.
        </li>
        <li>We do not sell data, and we do not run ads or ad trackers.</li>
      </ul>

      <h2>What is kept on your device</h2>
      <ul>
        <li>
          Your notes, in your browser&apos;s storage, encrypted with AES-GCM under a key from your seed. Without the
          seed they are unreadable.
        </li>
        <li>
          With a passkey, which account it opens. With a NEAR wallet, nothing secret: your wallet signs the same message
          again each time you open your balance.
        </li>
        <li>Your theme and your cookie choice.</li>
      </ul>
      <p>
        Clearing this site&apos;s data removes all of it. Every note you make for yourself is also on the board, sealed
        to you, so your seed alone recovers your balance. See <Link href="/cookies">cookies and storage</Link>.
      </p>

      <h2>What is public on NEAR</h2>
      <p>
        Some things are public because they happen on a public blockchain, and nobody, including us, can remove them:
      </p>
      <ul>
        <li>Deposits into the pool and cash outs from it, with the NEAR account, the token and the amount.</li>
        <li>That a desk deal happened, its maker, its settlement class, its bond and how it ended.</li>
        <li>The hedge order of a hedged deal, on the desk and on Hyperliquid testnet.</li>
        <li>Board posts, which are ciphertexts that only their recipient can open.</li>
      </ul>
      <p>
        What happens inside the pool, and who traded what, is not public. The full list is in{" "}
        <Link href="/docs/privacy-model">the privacy model</Link>.
      </p>

      <h2>What our services see</h2>
      <p>
        <strong>Request metadata.</strong> Like any web server, the API, the relayer and the hosted MCP server see the
        IP address and timing of each request. Hushd&apos;s own services keep IP addresses only in memory, to limit
        request rates. The hosting providers that serve the site and the API may keep their usual access logs.
      </p>
      <p>
        <strong>Sealed content.</strong> The API stores what the desk needs to work: sealed requests, the asks sealed to
        each maker, sealed quotes, sealed deal room messages and match results, plus the public events it indexes from
        the chain. It cannot open anything sealed. The relayer sees the actions it sends, which are public once on chain
        anyway, and never your keys.
      </p>
      <p>
        <strong>Testnet data</strong> may be deleted at any time, for example when the testnet contracts are deployed
        again.
      </p>

      <h2>Plain-language intake</h2>
      <p>
        When you describe a deal in words, your browser encrypts the text to a model on NEAR AI Cloud whose TEE
        attestation has been verified, and checks the model&apos;s signed answer. Our API only passes the ciphertext on
        with an API key; it cannot read your words, and neither can the NEAR AI gateway. The model reads them inside its
        TEE. NEAR AI Cloud&apos;s own terms cover its service.
      </p>

      <h2>Other services your browser talks to</h2>
      <ul>
        <li>
          <strong>NEAR RPC nodes</strong> (FastNEAR and the NEAR testnet RPC), which your browser reads the chain from.
          They see your IP address and what you read.
        </li>
        <li>
          <strong>Your wallet</strong>, if you connect one through NEAR Connect. Each wallet has its own privacy policy.
        </li>
        <li>
          <strong>Vercel Web Analytics</strong>, only if you choose Accept all: cookieless page view counts. Before
          anything is sent, the address is cut to its path, so nothing after a <code>?</code> or <code>#</code> leaves
          your browser.
        </li>
      </ul>

      <h2>Proofs you share</h2>
      <p>
        A proof shows one fact to the account it names. You decide who gets it. A proof link carries the proof after
        the <code>#</code>, which browsers do not send to our servers when the link is opened.
      </p>

      <h2>Changes</h2>
      <p>
        If this page changes, the date at the top changes with it, and the history is public in the repository.
      </p>
    </LegalLayout>
  );
}
