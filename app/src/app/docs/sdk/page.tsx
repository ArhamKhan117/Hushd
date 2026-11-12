import type { Metadata } from "next";
import Link from "next/link";
import { DocsLayout } from "@/components/DocsLayout";
import { Callout } from "@/components/docs/FlowDiagram";

export const metadata: Metadata = {
  title: "SDK",
  description:
    "@hushd/sdk in TypeScript: identities and hushd1 addresses, the private wallet, claim links, the desk for traders and makers, proofs to one named reader, NEAR AI intake, private x402 and chain reads.",
  alternates: { canonical: "/docs/sdk" },
};

const GROUPS: { id: string; title: string; rows: [string, string][] }[] = [
  {
    id: "network",
    title: "Network",
    rows: [
      ["TESTNET, MAINNET", "Where Hushd lives: RPC, contracts, tokens, the API. MAINNET names the mainnet contracts and real tokens; deployed is false until they exist"],
      ["withOverrides(net, partial)", "Point any field elsewhere: a local sandbox, a self-hosted API"],
      ["tokenInfo(net, idOrSymbol)", "A token's account id, symbol, decimals and hedge coin"],
      ["txUrl, accountUrl", "NearBlocks links for a transaction or an account"],
    ],
  },
  {
    id: "identity",
    title: "Identity",
    rows: [
      ["identityFromSeed(seed)", "The spending key, receive key, X25519 key and hushd1… address from 32 bytes"],
      ["randomSeed()", "A fresh seed, for an agent or a test. Keep it: it is the identity"],
      ["seedFromSignature(sig), SEED_MESSAGE", "The seed behind a NEP-413 wallet signature of the fixed message"],
      ["encodeAddress, decodeAddress, isAddress", "hushd1… addresses: bech32m of the receive key and the X25519 key"],
    ],
  },
  {
    id: "wallet",
    title: "Private wallet",
    rows: [
      ["new PrivateWallet(net, id, { artifacts, relayer, store })", "The notes one identity owns, synced with the pool and the board"],
      ["restore(), sync()", "Load the store, then pull new leaves and board posts and mark spent notes"],
      ["balances(), spendable(token), pending()", "What it holds, what it can spend now, what is still landing"],
      ["shield(token, amount)", "A new note, the ft_transfer_call to sign, and the self-post that makes it recoverable"],
      ["send(to, token, amount, memo?)", "Pay a hushd1… address privately, through the relayer"],
      ["pay(note, { word, beforeSend })", "Pay a note made beforehand, optionally sealing word of it to its owner"],
      ["cashOut(account, token, amount, fee?)", "Pay out to a NEAR account, with a refund note if the payout fails"],
      ["payments(), deals()", "What it paid and traded, ready for a proof"],
      ["MemoryStore, artifactsAt(base)", "An in-memory store, and proving artifacts from a URL"],
    ],
  },
  {
    id: "links",
    title: "Claim links",
    rows: [
      ["payAsLink(wallet, token, amount)", "Pay into a one-time note and get a link for it; the link is in the wallet's store before the payment goes out"],
      ["linkUrl(appOrigin, link), parseLink(urlOrCode)", "The URL to share (the code after the #), and back"],
      ["encodeLink, decodeLink, newLink", "The versioned, checked code on its own; a LinkError says what is wrong with a damaged one"],
      ["checkLink(net, link)", "ready, claimed or missing, from the pool: only a ready link's amount is real"],
      ["claimLink(link, { to, artifacts, relayer })", "Spend the link note into a new note for to's receive key, through the relayer: no gas"],
      ["sentLinks(wallet), takeBackLink(wallet, link, opts)", "The links a wallet paid with their state, and taking back one nobody claimed"],
      ["ALREADY_CLAIMED", "The one answer for a spent link, claimed or taken back"],
    ],
  },
  {
    id: "desk",
    title: "Desk",
    rows: [
      ["packageRequest(id, net, draft)", "The sealed request (with the limit) and the ask makers see"],
      ["openRfq({ net, api, relayer, request, ask, windowMs })", "Seal and commit the request, and send each maker its ask, skipping makers that let too many deals lapse"],
      ["readMakerRecords(net), makersToAsk", "Each maker's record from the desk's deals (settled, lapsed, lapse rate), and the makers a request asks"],
      ["awaitMatch(api, dealIdentity, rfqId)", "Wait for the enclave and open the terms sealed to this deal's one-time address"],
      ["checkMatchedTerms(terms, draft)", "Refuse a match below your limit, in another token or another package"],
      ["isBondStep(bond, minBond), bondStepAtLeast(atLeast, minBond)", "The desk takes a bond only in steps of its minimum (1, 2, 5, 10, 20... times it)"],
      ["settleAsTrader, settleAsMaker", "Each side's settlement, from planning to the settled deal (the trader's then moves into its balance)"],
      ["deskView", "config, enclave, makers, deal, deals, stats"],
      ["new DeskApi(url), new RelayerClient(url)", "The API's request intake and deal rooms, and the relayer"],
      ["ownerKeyFor, closeHedgeSignature", "The per-deal key that alone closes a hedge, and its signature"],
      ["dealIdentityFor, wallet.moveDealNote(dealId)", "The one-time address a deal pays you at, and the private send that moves its note into your balance"],
    ],
  },
  {
    id: "proofs",
    title: "Proofs",
    rows: [
      ["proveReceipt(src, id, scope, made, paidWith, opts)", "A payment, exact or at least an amount"],
      ["proveFunds(src, id, scope, tree, notes, threshold)", "At least a threshold, in one to four notes"],
      ["proveVolume(src, id, scope, legs)", "The total delivered across one to sixteen desk deal legs"],
      ["encodeProof, decodeProof", "To and from a hushdproof1… string"],
      ["verifyProof(net, proof, vkey, { asReader })", "Check it as its reader would: off chain, then through the pool"],
    ],
  },
  {
    id: "intake",
    title: "Intake",
    rows: [
      ["intake(apiBase, text)", "Your words to a draft package, end-to-end encrypted, with the TEE's signature checked"],
      ["intakeAttestation(apiBase)", "The model's verified attestation, and whether intake is on"],
      ["encryptForModel, decryptFromModel", "The encryption the intake uses, on its own"],
    ],
  },
  {
    id: "x402",
    title: "x402",
    rows: [
      ["paymentRequired(net, requirement)", "The 402 body for scheme hushd"],
      ["x402Fetch(wallet, url, init, { maxAmount })", "Fetch, and pay a private 402 within a cap"],
      ["verifyX402Payment(net, payee, header, price, seen)", "Check an X-PAYMENT header on the server"],
      ["paymentResponse, x402Network, X402_SCHEME", "The response header, the network name, the scheme"],
    ],
  },
  {
    id: "reads",
    title: "Reads",
    rows: [
      ["poolView", "root, isKnownRoot, nextLeafIndex, leaves, isSpent, spendOf, assets, stats, config, verifyDisclosure"],
      ["boardView, scanBoard", "Board posts, and the ones that open for an identity"],
      ["loadTree(net)", "The pool's Merkle tree rebuilt from its stored leaves"],
      ["view, accountBalance, txStatus, latestBlock", "Plain NEAR RPC reads, with endpoint fallback"],
    ],
  },
];

export default function SdkDocsPage() {
  return (
    <DocsLayout
      title="SDK"
      lede="@hushd/sdk is the TypeScript behind the app, the MCP server and the makers. It works in the browser and in Node, and you sign everything yourself."
      glance={[
        { label: "Package", value: "@hushd/sdk" },
        { label: "Runs in", value: "Browser and Node 22+" },
        { label: "Network", value: "NEAR testnet" },
      ]}
    >
      <h2 id="install">Install</h2>
      <pre>
        <code className="language-bash">{`npm install @hushd/sdk`}</code>
      </pre>
      <p>
        <a href="https://www.npmjs.com/package/@hushd/sdk">@hushd/sdk</a> on npm is compiled ES modules with types; its
        source is <code>packages/sdk</code> in the repo, and inside the monorepo you depend on it with{" "}
        <code>&quot;@hushd/sdk&quot;: &quot;workspace:*&quot;</code>. Node-only helpers, an encrypted note file and
        cached proving artifacts, are in <code>@hushd/sdk/node</code>.
      </p>
      <p>
        Call <code>loadPoseidon()</code> once before anything that hashes: identities, notes and proofs all use it.
      </p>

      <h2 id="a-trade-end-to-end">A trade, end to end</h2>
      <pre>
        <code className="language-ts">{`import {
  awaitMatch, checkMatchedTerms, DeskApi, identityFromSeed, loadPoseidon, openRfq,
  packageRequest, PrivateWallet, RelayerClient, settleAsTrader, TESTNET,
  type PackageDraft,
} from "@hushd/sdk";
import { cachedArtifacts, EncryptedFileStore } from "@hushd/sdk/node";

await loadPoseidon();
const id = identityFromSeed(seed); // 32 bytes you keep secret
const relayer = new RelayerClient(TESTNET.api);
const api = new DeskApi(TESTNET.api);
const wallet = new PrivateWallet(TESTNET, id, {
  artifacts: await cachedArtifacts({ cacheDir: ".hushd/circuits" }),
  relayer,
  store: new EncryptedFileStore(".hushd/notes", seed),
});
await wallet.restore();
await wallet.sync();

// Sell 100 USDC for wNEAR, taking the best quote.
const draft: PackageDraft = {
  kind: "spot",
  sell: { token: "usdc.hushd.testnet", amount: 100_000_000n },
  buy: { token: "wnear.hushd.testnet", minAmount: 0n },
};
// the request names a one-time address for this deal alone (dealIdentity), never yours
const { request, ask, refundBlinding, dealIdentity } = packageRequest(id, TESTNET, draft);
const { rfqId } = await openRfq({ net: TESTNET, api, relayer, request, ask, windowMs: 45_000 });
const match = await awaitMatch(api, dealIdentity, rfqId);
checkMatchedTerms(match.terms, draft); // throws unless the match is what you asked for
const { moved } = await settleAsTrader({
  net: TESTNET, api, wallet, refundBlinding, // re-derives the deal's owner key and its one-time address
  dealId: match.dealId, terms: match.terms, makerAddress: match.maker_address,
});
// moved.state "moved": the tokens are in your balance; "waiting": the next wallet.sync() moves them`}</code>
      </pre>
      <p>
        The enclave picks the best quote, but you check the result before your leg is proved:{" "}
        <code>checkMatchedTerms</code> refuses a match that pays less than your <code>minAmount</code>, in another
        token, or as another package. A deal you do not settle simply expires.
      </p>
      <p>
        For a hedged package, keep the <code>refundBlinding</code> that <code>packageRequest</code> returns: it
        re-derives the key that closes the hedge, the note a slashed bond pays you, and the deal&apos;s one-time
        address. The maker pays your leg to that address; the wallet keeps the note&apos;s opening and moves it into
        your balance with a private send through the relayer, trying again on each sync until it lands. The desk page in the app does
        exactly this, in <code>app/src/app/app/page.tsx</code>.
      </p>

      <h2 id="a-private-payment">A private payment</h2>
      <pre>
        <code className="language-ts">{`// The deposit is yours to sign: send call to the token contract (1 yocto attached).
const { call, selfPost } = wallet.shield("usdc.hushd.testnet", 25_000_000n);
await relayer.post(selfPost, "note"); // so your seed alone can recover this note

// Later, from the private balance, through the relayer.
const { txHash } = await wallet.send("hushd1…", "usdc.hushd.testnet", 10_000_000n, "invoice 7");`}</code>
      </pre>

      <h2 id="pay-as-a-link">Pay as a link</h2>
      <p>
        To pay someone who is not on Hushd yet, pay into a one-time note and hand them a link. The link carries the
        note&apos;s opening after the <code>#</code>, which browsers never send to a server. Whoever opens it first
        claims the payment into a new note for their own receive key, made on their device, so after the claim you
        cannot spend it back. Until then you can take it back.
      </p>
      <pre>
        <code className="language-ts">{`import { checkLink, claimLink, linkUrl, parseLink, payAsLink, sentLinks, takeBackLink, TESTNET } from "@hushd/sdk";

// The payer: the link is saved in the wallet's encrypted store before the payment goes out.
const { link } = await payAsLink(wallet, "usdc.hushd.testnet", 25_000_000n);
const url = linkUrl("https://hushd.net", link); // https://hushd.net/app/claim#…, share it privately

// The claimer: check the pool first, then claim into their own wallet. The relayer pays the gas.
const theirs = parseLink(url);
const check = await checkLink(TESTNET, theirs); // "ready", "claimed" or "missing"
if (check.state === "ready") await claimLink(theirs, { to: theirWallet, artifacts, relayer, tree: check.tree });

// Later, the payer: where each link stands, and taking back one nobody claimed.
const [first] = await sentLinks(wallet); // state: "waiting", "claimed", "taken back", …
if (first?.state === "waiting") await takeBackLink(wallet, first.link, { artifacts, relayer });`}</code>
      </pre>

      <h2 id="exports">Exports</h2>
      {GROUPS.map((g) => (
        <div key={g.id}>
          <h3 id={g.id}>{g.title}</h3>
          <table>
            <thead>
              <tr>
                <th>Export</th>
                <th>What it is for</th>
              </tr>
            </thead>
            <tbody>
              {g.rows.map(([k, v]) => (
                <tr key={k}>
                  <td>
                    <code>{k}</code>
                  </td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <p>
        Lower down, the SDK also exports what these are built from: notes (<code>makeNote</code>,{" "}
        <code>nullifierOf</code>), the Merkle tree (<code>MerkleTree</code>, depth 20), Poseidon, the joinsplit prover,
        the pool&apos;s call arguments (<code>shieldCall</code>, <code>transactRequest</code>, <code>swapLeg</code>), the
        domain hashes (<code>assetField</code>, <code>extHash</code>, <code>swapExtHash</code>,{" "}
        <code>proofContext</code>) and the sealed boxes (<code>sealJson</code>, <code>openJson</code>).
      </p>

      <h2 id="guardrails">Guardrails</h2>
      <ul>
        <li>The SDK never holds a NEAR key. A deposit is a call you sign; everything private goes through the relayer.</li>
        <li>
          Proofs are made where the SDK runs. The prover needs the circuits&apos; artifacts, checked against their
          sha256 in <code>manifest.json</code>.
        </li>
        <li>
          The relayer checks every proof before sending it, and can refuse. It cannot change what was proved.
        </li>
      </ul>
      <Callout title="Agents first?">
        If you are giving an AI agent a wallet, the <Link href="/docs/agents">MCP server</Link> wraps all of this with
        spending limits, and needs no code.
      </Callout>
    </DocsLayout>
  );
}
