import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "Security and threat model",
  description:
    "What each part of Hushd can and cannot do to you: your keys, the relayer, the matcher enclave, the intake model, Hushd's API, matcher client and keeper, makers, the contracts and the development proving keys. Testnet only and not audited.",
  alternates: { canonical: "/docs/threat-model" },
};

export default function ThreatModelPage() {
  return (
    <DocsLayout
      title="Security and threat model"
      lede="Who could hurt you, how, and what stops them. Read this before relying on any part of Hushd, and remember it runs on testnet with development keys and no audit."
      glance={[
        { label: "Network", value: "Testnet only" },
        { label: "Proving keys", value: "Development, one contributor" },
        { label: "Audit", value: "None yet" },
      ]}
    >
      <h2 id="what-hushd-protects">What Hushd protects</h2>
      <ul>
        <li>
          <strong>Custody.</strong> Only the holder of a note&apos;s spending key can spend it. No account, Hushd&apos;s
          included, can move pooled funds: the pool has no admin withdraw.
        </li>
        <li>
          <strong>Atomicity.</strong> Both legs of a spot deal are applied in one call, or neither is.
        </li>
        <li>
          <strong>Privacy inside the pool.</strong> Amounts and parties of transfers and settlements, as set out in{" "}
          <Link href="/docs/privacy-model">the privacy model</Link>.
        </li>
        <li>
          <strong>Privacy of the request.</strong> Your limit and your words, up to the trust you place in the matcher
          enclave and the intake model.
        </li>
      </ul>

      <h2 id="your-keys-and-notes">Your keys and notes</h2>
      <p>
        Your seed comes from a NEAR wallet&apos;s signature of one fixed message, or from a passkey. Anyone who gets it
        can spend your private balance. Malware on your device, or a tampered copy of the app, could take it. The app
        at hushd.net is open source; you can build and run it yourself instead.
      </p>

      <h2 id="agents">Agents</h2>
      <p>
        An agent&apos;s private balance is guarded by the spending limits in its local MCP server, which runs beside the
        agent with its seed. The relayer sends whatever was proved and does not know those limits. Anything that can
        read the seed, the agent itself included when it has shell or file access, can spend the whole balance without
        asking the server. A policy wallet guards the agent&apos;s NEAR account in a TEE, not its private balance, so
        keep in that balance only what the agent may lose. See{" "}
        <Link href="/docs/agents#spending-limits">spending limits</Link>.
      </p>

      <h2 id="the-relayer">The relayer</h2>
      <p>
        The relayer sends proven actions from its own account. Before it sends one it checks the proof against the
        exact inputs the contract will rebuild, that the root is known and that every note is unspent. It sends only
        to an allowlist of contracts and methods, with a rate limit per client and a daily gas budget.
      </p>
      <ul>
        <li>
          <strong>It can</strong> refuse or delay an action, and see when it arrived and from where.
        </li>
        <li>
          <strong>It cannot</strong> change what you proved. A cash out&apos;s recipient, the fee, the relayer, the
          refund note and the memo are bound into the proof, and each leg of a swap is bound to its deal and to all four
          outputs. A changed action fails the contract&apos;s check.
        </li>
      </ul>

      <h2 id="the-matcher-enclave">The matcher enclave</h2>
      <p>
        The matcher is a WASI module run as an OutLayer project inside Intel TDX. Its key is generated inside the TEE,
        and the desk learned it through an OutLayer call, so it comes from that code. The desk accepts a match only
        from OutLayer&apos;s callback or with that key&apos;s signature, and trusts OutLayer to resume only with
        results from attested workers running the pinned matcher.
      </p>
      <p>If the TEE, or that trust, failed, whoever broke it could:</p>
      <ul>
        <li>read requests, limits and quotes, and</li>
        <li>
          match you with a quote other than the best. A match below your limit, in another token or for another
          package is refused by your own client before it proves anything, so the deal just expires.
        </li>
      </ul>
      <p>
        They could not invent a maker&apos;s consent (the desk checks each maker&apos;s quote key), and could not move
        your notes: settlement still needs your own proof, and your client checks the note it receives opens to the
        agreed terms before it proves.
      </p>

      <h2 id="the-intake-model">The intake model</h2>
      <p>
        The API verifies the model&apos;s TDX and NVIDIA GPU attestation and gives your browser its signing key; your
        browser encrypts your words to that key and checks the TEE&apos;s signature on the answer. It accepts only a
        signature by that same key, whatever signer the API names, so an API that swapped in a key of its own for the
        answer gets a draft marked not verified. The browser relies on the API&apos;s attestation check; you can check the same model yourself at{" "}
        <a href="https://cloud.near.ai/verify" target="_blank" rel="noreferrer">
          cloud.near.ai/verify
        </a>
        . Whatever the model answers is only a draft in a form you check.
      </p>

      <h2 id="hushds-services">The API, the matcher client and the keeper</h2>
      <p>
        Hushd runs these services itself, next to the relayer. Their health is on{" "}
        <Link href="/transparency">Transparency</Link>.
      </p>
      <ul>
        <li>
          <strong>The API</strong> stores the sealed requests, quotes and deal-room messages and hands them on. It
          cannot open them, but it sees the network side of everything that passes through it: IP addresses, timing
          and deal-room traffic. It can refuse, delay or drop a message. In a deal room it sees which deal each
          message is for, its size and time, and the key it is sealed to: the maker&apos;s own, or a key the
          trader&apos;s wallet made for that deal alone, which leads to no hushd1… address. It deletes a room once its
          deal settles or closes on the desk, and any message after a day.
        </li>
        <li>
          <strong>The matcher client</strong> builds each batch for the enclave from the quotes in the API&apos;s
          database. It cannot read them or forge a match, but it could leave a quote out, and the enclave could not
          tell: the best quote the enclave sees may not be the best one sent. It can also hold a batch back until the
          match is too late for the desk.
        </li>
        <li>
          <strong>The keeper</strong> submits each hedge order to Hyperliquid and alone reports whether it filled. The
          desk releases or slashes the maker&apos;s bond on that report, so a false fill would keep a missed
          hedge&apos;s bond from you, and a false miss would take an honest maker&apos;s bond. If the keeper reports
          nothing, anyone may slash an overdue hedge (<code>slash_overdue</code>) and expire an unsettled deal
          (<code>expire</code>).
        </li>
      </ul>

      <h2 id="makers">Makers</h2>
      <ul>
        <li>A maker can decline to quote, quote badly, or fail to settle. An unsettled deal expires, and nothing moves.</li>
        <li>
          A maker has a last look. You prove your leg first and hand it over, and the maker submits both legs, so it
          can wait out the settlement window and settle only if the price still suits it. On a spot deal that costs it
          nothing, since there is no bond; a hedged deal&apos;s bond is released too when a deal expires unsettled.
          See <Link href="/docs/desk#last-look">last look</Link>.
        </li>
        <li>
          A maker that misses a hedge, as the keeper reports it, loses its bond to the trader. The hedge itself trades
          for the maker&apos;s own Hyperliquid account: it does not hedge the trader (see{" "}
          <Link href="/docs/packages#spot-and-hedge">packages</Link>).
        </li>
        <li>
          A bond is public, so the desk takes it only in fixed steps of its minimum (1, 2, 5, 10, 20, 50 and so on
          times it): the bond says which step a trade falls in, not its size. A hedge order is public on Hyperliquid,
          so a hedged deal&apos;s size is not private.
        </li>
        <li>
          A maker sees the pair, the side and the size of every ask sealed to it, and could act on that elsewhere.
        </li>
      </ul>

      <h2 id="the-contracts">The contracts</h2>
      <ul>
        <li>
          Pool rule changes (listing a token, its deposit limits, the desk it trusts, its owner) wait out a public
          timelock, and anyone can apply them after. The owner can pause new deposits at once, never cash outs.
        </li>
        <li>
          The desk&apos;s pool, bond token and Chain Signatures signer are fixed when it is created. Its other
          settings (the keeper, the matcher project, the minimum bond) change only after a public one-day timelock,
          and never touch notes in the pool.
        </li>
        <li>
          A cash out the token refuses comes back as a refund note, and a failed swap applies nothing. Failed bond
          moves are credited back.
        </li>
      </ul>

      <h2 id="proving-keys">Proving keys</h2>
      <Callout tone="caveat" title="Development keys">
        The Groth16 keys came from the public Perpetual Powers of Tau, then one phase-2 contribution with random
        entropy held only in memory, then a public beacon (a NEAR mainnet block hash). Whoever ran that contribution
        could have kept the entropy, and with it make proofs the keys accept without the notes behind them. That is
        why these keys are for testnet. Real money needs a multi-party ceremony, where one honest contributor is
        enough.
      </Callout>
      <p>
        The transcript is in <code>circuits/KEYS.md</code>, and the browser&apos;s copies of the keys are listed with
        their sha256 in <code>/circuits/manifest.json</code>.
      </p>

      <h2 id="not-audited">Not audited</h2>
      <p>
        The contracts, circuits and services have unit, circuit and sandbox tests. No external audit has been done.
      </p>

      <h2 id="not-covered">Not covered</h2>
      <ul>
        <li>
          Sanctions screening beyond its list: it checks public addresses against a dated OFAC snapshot, so it misses
          an address listed later or one that is not listed at all. Transfers inside the pool are private and are not
          screened.
        </li>
        <li>Network privacy: your IP address, as seen by the API, the relayer and NEAR RPC nodes.</li>
        <li>A compromised device or browser.</li>
        <li>Real value: there is none on testnet, by design.</li>
      </ul>

      <h2 id="reporting-a-problem">Reporting a problem</h2>
      <p>
        Open an issue on{" "}
        <a href="https://github.com/ArhamKhan117/Hushd/issues" target="_blank" rel="noreferrer">
          GitHub
        </a>
        . If the problem could put someone at risk, say only that you found one and ask for a private way to share it,
        without details. Test against testnet, or a local sandbox. See also <Link href="/security">security</Link>.
      </p>
    </DocsLayout>
  );
}
