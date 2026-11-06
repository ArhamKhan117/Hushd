import type { Metadata } from "next";
import Link from "next/link";
import { CopyCommand } from "@/components/CopyCommand";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { FlowField } from "@/components/ui/FlowField";
import { SealDots } from "@/components/ui/SealDots";
import { SealedField } from "@/components/ui/SealedField";
import { CodeTabs, type CodeTab } from "./SdkClient";

export const metadata: Metadata = {
  title: "Developers",
  description:
    "Build on Hushd: @hushd/sdk for private balances, sealed desk requests, atomic settlement, proofs to one named reader and private x402, and an MCP server for agents. TypeScript, NEAR testnet.",
  alternates: { canonical: "/sdk" },
};

const GITHUB = "https://github.com/ArhamKhan117/hushd";

/* ---------- line icons (same hand as the landing) ---------- */

const icon = "h-6 w-6 text-foreground";
function IconBalance() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="6" width="17" height="12.5" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 10h17" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="16.5" cy="14.5" r="1.1" fill="currentColor" />
    </svg>
  );
}
function IconDesk() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 8.5h12.5M14.5 5.5l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 15.5H6.5M9.5 12.5l-3 3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconMaker() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="7" width="15" height="11" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M12 7V4.5M9.5 12h.01M14.5 12h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9.5 15h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconProve() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3l7-2.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M9 12.2l2.2 2.2L15.2 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconWords() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 6.5h14a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5h-7.5L7.5 19.5v-3H5A1.5 1.5 0 0 1 3.5 15V8A1.5 1.5 0 0 1 5 6.5z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M7.5 10.5h9M7.5 13h5.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
function IconPay() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="5.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="18.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7.5 12h3M13.5 12h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <rect x="10.5" y="9.5" width="3" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

const SURFACE = [
  {
    icon: <IconBalance />,
    title: "Private balance",
    body: "Notes only the holder can spend: add privately, send to a hushd1… address, cash out to any NEAR account.",
    fn: "PrivateWallet",
  },
  {
    icon: <IconDesk />,
    title: "The desk, for traders",
    body: "Seal a package request to the enclave, commit it on chain, wait for the match and settle your leg.",
    fn: "openRfq",
  },
  {
    icon: <IconMaker />,
    title: "The desk, for makers",
    body: "Open the asks sealed to you, sign quotes with your quote key, and settle the deals you win.",
    fn: "settleAsMaker",
  },
  {
    icon: <IconProve />,
    title: "Proofs to one reader",
    body: "A payment, funds held or desk volume, for one named NEAR account until it expires. Check them the same way.",
    fn: "proveFunds",
  },
  {
    icon: <IconWords />,
    title: "Plain-language intake",
    body: "Turn a trader's words into a draft package on NEAR AI Cloud, encrypted end to end, with the TEE's signature checked.",
    fn: "intake",
  },
  {
    icon: <IconPay />,
    title: "Private x402",
    body: "Pay a 402 from a private balance, or charge for your own API and check each payment on your server.",
    fn: "verifyX402Payment",
  },
];

const TRADE_SNIPPET = `import {
  awaitMatch, checkMatchedTerms, DeskApi, openRfq, packageRequest,
  RelayerClient, settleAsTrader, TESTNET, type PackageDraft,
} from "@hushd/sdk";

const api = new DeskApi(TESTNET.api);
const relayer = new RelayerClient(TESTNET.api);

// 1. The request, with your limit: sealed to the enclave only.
const draft: PackageDraft = {
  kind: "spot",
  sell: { token: "usdc.hushd.testnet", amount: 100_000_000n },
  buy: { token: "wnear.hushd.testnet", minAmount: 0n },
};
const { request, ask, refundBlinding } = packageRequest(identity, TESTNET, draft);

// 2. Commit its hash on chain; each maker gets the ask, sealed to it.
const { rfqId } = await openRfq({ net: TESTNET, api, relayer, request, ask, windowMs: 45_000 });

// 3. The enclave's match, sealed to you. Check it is what you asked for.
const match = await awaitMatch(api, identity, rfqId);
checkMatchedTerms(match.terms, draft);

// 4. Approve the four outputs, prove your leg; both legs settle in one pool call.
await settleAsTrader({
  net: TESTNET, api, wallet, refundBlinding,
  dealId: match.dealId, terms: match.terms, makerAddress: match.maker_address,
});`;

const PROVE_SNIPPET = `import { encodeProof, proveReceipt, verifyProof, TESTNET } from "@hushd/sdk";

// The latest payment this wallet made, for auditor.testnet, valid for 7 days.
const [p] = wallet.payments();
const proof = await proveReceipt(artifacts, identity, {
  net: TESTNET,
  reader: "auditor.testnet",
  expiresAtMs: Date.now() + 7 * 86_400_000,
}, p.made, p.paidWith);

const link = \`https://hushd.net/verify#p=\${encodeProof(proof)}\`;

// The reader's side: off chain, then through the pool contract.
const verdict = await verifyProof(TESTNET, proof, vkey, { asReader: "auditor.testnet" });`;

const X402_SNIPPET = `import { paymentRequired, verifyX402Payment, TESTNET } from "@hushd/sdk";

// 0.01 test USDC per call, paid privately to your hushd1… address.
const price = { maxAmountRequired: "10000", asset: "usdc.hushd.testnet" };

const header = req.headers.get("x-payment");
if (!header) {
  return json(paymentRequired(TESTNET, { ...price, payTo: me.address, resource: req.url }), 402);
}

const paid = await verifyX402Payment(TESTNET, me, header, price, seen);
if (!paid.ok) return json({ error: paid.reason }, 402);
return json(await answer(req)); // the pool made exactly that note, for at least the price`;

const TABS: CodeTab[] = [
  { id: "trade", label: "Trade", file: "trade.ts", code: TRADE_SNIPPET },
  { id: "prove", label: "Prove", file: "prove.ts", code: PROVE_SNIPPET },
  { id: "x402", label: "x402 server", file: "x402.ts", code: X402_SNIPPET },
];

const MCP_TOOLS = [
  { name: "hushd_trade", body: "Ask the desk and settle privately" },
  { name: "hushd_pay_x402", body: "Pay a 402 resource from the private balance" },
  { name: "hushd_prove", body: "A proof for one named reader" },
  { name: "hushd_send", body: "Pay a hushd1… address privately" },
  { name: "hushd_balance", body: "The agent's private balance" },
  { name: "hushd_limits", body: "What it may spend, and what is left today" },
];

const MCP_CONFIG = `{
  "mcpServers": {
    "hushd": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/hushd", "mcp"],
      "env": {
        "HUSHD_LIMIT_PER_PAYMENT": "USDC=100,wNEAR=50",
        "HUSHD_LIMIT_PER_DAY": "USDC=500,wNEAR=250"
      }
    }
  }
}`;

const REFERENCES = [
  { path: "app", env: "Next.js", body: "The desk, the private balance and proofs, in the browser.", href: `${GITHUB}/tree/main/app` },
  { path: "packages/mcp", env: "Node", body: "An agent's wallet and desk seat over MCP, with limits.", href: `${GITHUB}/tree/main/packages/mcp` },
  { path: "services/src/makers.ts", env: "Node", body: "Three reference makers: price, quote, settle.", href: `${GITHUB}/blob/main/services/src/makers.ts` },
  { path: "matcher", env: "Rust", body: "The matcher enclave, built as an OutLayer module.", href: `${GITHUB}/tree/main/matcher` },
];

/* ---------- a mini product: one private x402 exchange ---------- */

function X402Exchange() {
  return (
    <div className="rounded-[14px] bg-panel p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[13px] text-mute">An agent</p>
          <p className="mt-0.5 text-[15px] text-foreground">Pays per call, privately</p>
        </div>
        <span className="rounded-full bg-surface px-2.5 py-1 text-[12px] text-mute">x402</span>
      </div>

      <ul className="mt-4 divide-y divide-line">
        <li className="flex min-h-[52px] items-center gap-3">
          <span className="tnum grid h-8 w-11 shrink-0 place-items-center rounded-full bg-surface text-[12px] text-foreground">GET</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-foreground">A paid resource</p>
            <p className="text-[12px] text-mute">Agent asks</p>
          </div>
        </li>
        <li className="flex min-h-[52px] items-center gap-3">
          <span className="tnum grid h-8 w-11 shrink-0 place-items-center rounded-full bg-surface text-[12px] text-foreground">402</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-foreground">Payment required, scheme hushd</p>
            <p className="text-[12px] text-mute">The price and a hushd1… address</p>
          </div>
        </li>
        <li className="flex min-h-[52px] items-center gap-3">
          <span className="grid h-8 w-11 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" stroke="currentColor" strokeWidth="2" />
              <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" stroke="currentColor" strokeWidth="2" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-foreground">Paid privately</p>
            <p className="text-[12px] text-mute">From its own balance, inside its limits</p>
          </div>
        </li>
        <li className="flex min-h-[52px] items-center gap-3">
          <span className="tnum grid h-8 w-11 shrink-0 place-items-center rounded-full bg-surface text-[12px] text-foreground">200</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] text-foreground">Delivered</p>
            <p className="text-[12px] text-mute">After the server checks the note</p>
          </div>
        </li>
      </ul>

      <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-surface px-3.5 py-2.5 text-[13px]">
        <span className="text-mute">
          <span className="max-sm:hidden">NearBlocks shows</span>
          <span className="sm:hidden">Explorer</span>
        </span>
        <span className="inline-flex items-center gap-2 whitespace-nowrap text-foreground">
          A pool call <SealDots n={4} className="text-foreground/60" label="Payer, payee and amount hidden" />
        </span>
      </div>
    </div>
  );
}

export default function SdkPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main id="main">
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="hd-panel flex min-h-[max(520px,calc(100svh-8rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:h-[calc(100svh-10rem)] lg:max-h-[980px] lg:min-h-[620px] lg:px-14 lg:pb-14">
            <FlowField />
            <div className="grid grid-cols-1 items-end gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-14">
              <div className="relative z-10 max-w-[720px]">
                <p className="t-label">Hushd for developers</p>
                <h1 className="t-display-xl mt-5">Private OTC, as a package</h1>
                <p className="mt-6 max-w-[50ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                  The same TypeScript the desk runs on: private balances, sealed requests, atomic settlement, proofs to
                  one named reader and private x402. Real proofs, checked on chain by NEAR.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <Link href="/docs/sdk" className="btn btn-ink btn-lg">
                    Read the SDK docs
                  </Link>
                  <Link href="/docs/agents" className="hd-arrowlink">
                    Agents and MCP <span aria-hidden>→</span>
                  </Link>
                </div>
              </div>

              <div className="hd-glass relative z-10 w-full p-2 lg:max-w-[460px] lg:justify-self-end">
                <div className="rounded-[12px] bg-panel p-4 sm:p-5">
                  <p className="text-[13px] text-mute">Get the code</p>
                  <a
                    href={GITHUB}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2.5 flex min-h-12 items-center justify-between gap-3 rounded-xl border border-line bg-panel py-1.5 pl-3.5 pr-3 text-[13.5px] text-foreground transition-colors hover:border-line-strong sm:pl-4 sm:text-[14.5px]"
                  >
                    <span className="min-w-0 [overflow-wrap:anywhere]">github.com/ArhamKhan117/hushd</span>
                    <ArrowUpRight className="text-mute" />
                  </a>
                  <p className="mt-5 text-[13px] text-mute">Then, in a clone of it</p>
                  <div className="mt-2.5">
                    <CopyCommand command="pnpm install" />
                  </div>
                  <div className="mt-5 flex flex-wrap gap-1.5 text-[12px] text-mute">
                    {["TypeScript", "Browser and Node", "Open source, MIT"].map((t) => (
                      <span key={t} className="rounded-full bg-surface px-2.5 py-1">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* quickstart: the ink panel */}
        <section id="quickstart" aria-labelledby="quickstart-title" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 py-14 sm:px-7 sm:py-20">
          <div className="theme-dark hd-panel grid grid-cols-1 gap-12 border border-line bg-background px-5 py-14 text-foreground sm:px-12 sm:py-20 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
            <SealedField tone="soft" />
            <div className="relative">
              <p className="t-label">Quickstart</p>
              <h2 id="quickstart-title" className="t-display-l mt-4 max-w-[14ch]">
                Five calls to a private trade
              </h2>
              <p className="mt-5 max-w-[46ch] text-[16px] leading-relaxed text-mute">
                Build the request, open it on the desk, wait for the enclave, check the terms, settle. Proofs are made
                where the code runs, and the SDK never holds a NEAR key.
              </p>
              <ul className="mt-10 divide-y divide-line border-y border-line text-[15px]">
                {[
                  ["Build the sealed request", "packageRequest"],
                  ["Commit it, send the asks", "openRfq"],
                  ["Wait for the match", "awaitMatch"],
                  ["Check the terms", "checkMatchedTerms"],
                  ["Settle your leg", "settleAsTrader"],
                ].map(([k, v]) => (
                  <li key={v} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-4">
                    <span>{k}</span>
                    <span className="text-[13.5px] text-mute">{v}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3">
                <Link href="/docs/sdk" className="hd-arrowlink">
                  The full example <span aria-hidden>→</span>
                </Link>
                <Link href="/docs/desk" className="hd-arrowlink">
                  How the desk works <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <div className="relative min-w-0">
              <CodeTabs tabs={TABS} />
            </div>
          </div>
        </section>

        {/* the surface */}
        <section aria-labelledby="surface" className="mx-auto max-w-[1240px] px-6 pb-20 sm:pb-28">
          <div className="max-w-[720px]">
            <h2 id="surface" className="t-display-l">
              Everything the desk does, in one import
            </h2>
            <p className="mt-5 max-w-[56ch] text-[16px] leading-relaxed text-mute">
              Pure TypeScript that runs in the browser and on a server, with the prover passed in so you choose where
              proofs are made.
            </p>
          </div>
          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {SURFACE.map((s) => (
              <div key={s.title} className="hd-tile flex min-h-[208px] flex-col p-6 sm:min-h-[248px]">
                <div className="flex items-start justify-between gap-4">
                  {s.icon}
                  <span className="max-w-full truncate rounded-full bg-panel px-2.5 py-1 text-[12px] text-mute">{s.fn}</span>
                </div>
                <div className="mt-auto pt-8 sm:pt-10">
                  <p className="text-[19px] leading-snug tracking-[-0.01em] text-foreground">{s.title}</p>
                  <p className="mt-2 text-[14px] leading-relaxed text-mute">{s.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* agents */}
        <section id="agents" aria-labelledby="agents-title" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 sm:px-7">
          <div className="hd-panel grid grid-cols-1 gap-12 bg-surface px-5 py-14 sm:px-12 sm:py-20 lg:grid-cols-2 lg:items-center lg:gap-16">
            <SealedField tone="soft" />
            <div className="relative">
              <p className="t-label">For agents</p>
              <h2 id="agents-title" className="t-display-l mt-4 max-w-[14ch]">
                No code: an MCP server with limits
              </h2>
              <p className="mt-5 max-w-[48ch] text-[16px] leading-relaxed text-mute">
                The MCP server wraps the SDK for any agent. It runs next to the agent with its own seed, proves on that
                machine, and refuses anything over the caps you set per payment and per day.
              </p>
              <ul className="mt-10 divide-y divide-line border-y border-line">
                {MCP_TOOLS.map((t) => (
                  <li key={t.name} className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                    <span className="text-[14.5px] text-foreground">{t.body}</span>
                    <span className="truncate text-[13px] text-mute">{t.name}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-8 flex flex-wrap gap-2">
                <Link href="/docs/agents" className="btn btn-ink">
                  Connect an agent
                </Link>
                <a href={`${GITHUB}/tree/main/packages/mcp`} target="_blank" rel="noreferrer" className="btn btn-quiet">
                  MCP server on GitHub <ArrowUpRight />
                </a>
              </div>
            </div>

            <div className="relative min-w-0">
              <div className="hd-glass p-2 shadow-pop">
                <X402Exchange />
              </div>
              <div className="theme-dark mt-3 text-foreground">
                <CodeBlock code={MCP_CONFIG} lang="json" title="Any MCP client" meta="mcp.json" className="bg-background" />
              </div>
            </div>
          </div>
        </section>

        {/* start from a reference */}
        <section aria-labelledby="references" className="mx-auto max-w-[1240px] px-6 py-20 sm:py-28">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.35fr]">
            <div className="hd-card flex flex-col justify-between p-7 sm:p-9">
              <div>
                <p className="t-label">One repository</p>
                <h2 id="references" className="t-display-m mt-4 max-w-[14ch]">
                  Every part, open source
                </h2>
                <p className="mt-4 max-w-[44ch] text-[15px] leading-relaxed text-mute">
                  The contracts, the circuits, the services, the matcher, the app and the SDK all live in one MIT
                  repository. Start from the part closest to what you build.
                </p>
              </div>
              <div className="mt-10">
                <CopyCommand command="git clone https://github.com/ArhamKhan117/hushd" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {REFERENCES.map((r) => (
                <a
                  key={r.path}
                  href={r.href}
                  target="_blank"
                  rel="noreferrer"
                  className="hd-tile group flex min-h-[176px] flex-col p-6 transition-colors hover:bg-surface-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full bg-panel px-2.5 py-1 text-[12px] text-mute">{r.env}</span>
                    <ArrowUpRight className="text-mute transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </div>
                  <div className="mt-auto pt-8">
                    <p className="text-[18px] leading-snug tracking-[-0.01em] text-foreground [overflow-wrap:anywhere]">{r.path}</p>
                    <p className="mt-1.5 text-[14px] leading-relaxed text-mute">{r.body}</p>
                  </div>
                </a>
              ))}
            </div>
          </div>
        </section>

        {/* honest status */}
        <section aria-labelledby="status" className="mx-auto max-w-[1240px] px-6">
          <div className="grid grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 id="status" className="t-display-l max-w-[11ch]">
                Honest about where it is
              </h2>
              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
                <a href={GITHUB} target="_blank" rel="noreferrer" className="hd-arrowlink">
                  Source on GitHub <ArrowUpRight />
                </a>
                <Link href="/docs/threat-model" className="hd-arrowlink">
                  Threat model <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-10 sm:grid-cols-3">
              {[
                {
                  title: "Testnet only",
                  body: "Every contract runs on NEAR testnet, with test tokens that have no value. No Hushd contract is on mainnet.",
                },
                {
                  title: "Development keys",
                  body: "The circuits' keys come from one phase-2 contribution and a public beacon, not a multi-party ceremony. Nothing is audited yet.",
                },
                {
                  title: "Nothing faked",
                  body: "When a read fails, these pages say so and show no number. Every count on them comes from the chain.",
                },
              ].map((t) => (
                <div key={t.title} className="border-t border-foreground pt-5">
                  <p className="text-[18px] leading-snug tracking-[-0.01em]">{t.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{t.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
