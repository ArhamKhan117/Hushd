import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { LiveDesk } from "@/components/landing/LiveDesk";
import { SealStream } from "@/components/landing/SealStream";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { FlowField } from "@/components/ui/FlowField";
import { SealDots } from "@/components/ui/SealDots";
import { SealedField } from "@/components/ui/SealedField";

/**
 * The Hushd landing. White ground, light display type, one luminous field, and
 * the desk's own words in place of illustration. Signature: the seal stream, a
 * request goes in readable and the chain records only its hash. Every number on
 * this page is read from the chain (LiveDesk); nothing is made up.
 */

/* ---------- line icons ---------- */

const icon = "h-6 w-6 text-foreground";
function IconSpot() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 8.5h12.5M14.5 5.5l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M19 15.5H6.5M9.5 12.5l-3 3 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconHedge() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3.5l7 2.8v5.2c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6.3l7-2.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8.5 10.5h7M13.5 8.5l2 2-2 2M15.5 14.5h-7M10.5 12.5l-2 2 2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCarry() {
  return (
    <svg className={icon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="8" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 10v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M14.5 8l5.5 8M20 12.5V16h-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const WHAT = [
  {
    label: "The desk",
    title: "Trade privately on testnet",
    body: "Say what you want to trade, or fill in the form. Maker agents quote, an enclave picks the best price inside your limit, and you settle from your private balance.",
    href: "/app",
    cta: "Open the desk",
  },
  {
    label: "The protocol",
    title: "A pool, a desk and a board",
    body: "Three contracts on NEAR testnet: a shielded pool of notes, a registry of makers and deals, and an encrypted board where payers leave word of a payment.",
    href: "/docs/contracts",
    cta: "See the contracts",
  },
  {
    label: "For builders",
    title: "Agents and makers",
    body: "An MCP server with spending limits, private x402 payments, and an SDK to run your own maker against the desk.",
    href: "/sdk",
    cta: "Developers",
  },
];

const STEPS = [
  {
    n: "1",
    title: "Sealed request",
    body: "Your request, with your limit, is sealed to the matcher enclave. Only its sha256 goes on chain. Makers get the pair, the side and the size, each sealed to them.",
  },
  {
    n: "2",
    title: "Enclave match",
    body: "Makers answer with quotes sealed to the enclave and signed by a quote key the desk checks. The enclave picks the best quote inside your limit, and the desk records the match.",
  },
  {
    n: "3",
    title: "Atomic private settlement",
    body: "Each side proves its own leg. Both legs settle in one pool call, settle_swap, so both happen or neither does.",
  },
  {
    n: "4",
    title: "Receipt",
    body: "Every deal ends with a receipt on the desk: settled, recovered, failed or unresolved, with the evidence behind it.",
  },
];

const PACKAGES = [
  {
    icon: <IconSpot />,
    title: "Spot",
    body: "Swap one token for another. Both legs are proven and settled together in the pool, atomically.",
    href: "/docs/packages#spot",
  },
  {
    icon: <IconHedge />,
    title: "Spot + hedge",
    body: "The swap, plus a Hyperliquid testnet short of what you buy, signed for this one deal by NEAR Chain Signatures and bonded by the maker.",
    href: "/docs/packages#spot-and-hedge",
  },
  {
    icon: <IconCarry />,
    title: "Cash and carry",
    body: "Buy with a stablecoin and short the perp of the same size, as one package with one receipt, bonded the same way.",
    href: "/docs/packages#cash-and-carry",
  },
];

const PROOFS = [
  ["Exact payment", "A payment you made, with its amount"],
  ["At least an amount", "A payment reached a line, amount hidden"],
  ["Funds held", "Unspent notes above a threshold"],
  ["Desk volume", "Total delivered across desk deals"],
];

const NEAR_ONLY = [
  {
    title: "Proofs checked in the contract",
    body: "The pool verifies every Groth16 proof inside the call, with NEAR's alt_bn128 host functions.",
  },
  {
    title: "A fresh hedge address per deal",
    body: "Chain Signatures sign each Hyperliquid hedge from the path hushd/hedge/<deal id>, so deals do not link there.",
  },
  {
    title: "Matching in a TEE, answered on chain",
    body: "The matcher runs as an OutLayer project in a TEE, and its result reaches the desk through yield and resume.",
  },
  {
    title: "Private, verifiable intake",
    body: "Your words are encrypted to an attested NEAR AI Cloud model, and its signed answer is checked in your browser.",
  },
  {
    title: "Readers are named accounts",
    body: "A proof is made for one NEAR account, like auditor.testnet, and says so to anyone else who holds it.",
  },
  {
    title: "Passkeys, no wallet needed",
    body: "A passkey derives a NEAR implicit account, so you can sign your own deposits without a seed phrase.",
  },
  {
    title: "You never appear as the sender",
    body: "The relayer sends proven actions from its own account on gas keys, and NEP-366 meta transactions for makers.",
  },
  {
    title: "Deposits in one call",
    body: "A NEP-141 ft_transfer_call moves tokens in, and the pool builds the note from what it actually received.",
  },
  {
    title: "Events anyone can index",
    body: "The contracts log NEP-297 events, read by the indexer from FastNEAR's neardata block stream.",
  },
];

const LIMITS = [
  {
    title: "Testnet only",
    body: "Every contract runs on NEAR testnet. Tokens come from a faucet and have no value, and the hedge trades on Hyperliquid testnet.",
  },
  {
    title: "Development keys",
    body: "Proofs use keys from one contribution plus a public beacon, not a multi-party ceremony. Fine for practice, not for real money.",
  },
  {
    title: "Not audited",
    body: "The contracts, circuits and services have tests, not an external audit.",
  },
  {
    title: "What the chain still shows",
    body: "Deposits, cash outs and their amounts are public, and so is each desk deal and its outcome. Timing can link them.",
  },
  {
    title: "Who you trust",
    body: "The relayer can refuse an action, never change what you proved. Keeping quotes and limits private rests on the matcher's TEE.",
  },
  {
    title: "The model only drafts",
    body: "The intake turns your words into a draft. You check every number before anything is sealed or sent.",
  },
];

const AGENT_SNIPPET = `# from a checkout of the repo
pnpm install
pnpm mcp init   # a new agent seed in ~/.hushd/seed

# the agent's own wallet, inside its limits
claude mcp add hushd \\
  -e HUSHD_LIMIT_PER_PAYMENT="USDC=100,wNEAR=50" \\
  -e HUSHD_LIMIT_PER_DAY="USDC=500,wNEAR=250" \\
  -- pnpm --silent --dir "$PWD" mcp

# or read-only, hosted
claude mcp add --transport http hushd-read https://hushd.net/mcp`;

const DEV_LINKS = [
  { label: "Agents and MCP", href: "/docs/agents" },
  { label: "Private x402", href: "/docs/x402" },
  { label: "Run a maker", href: "/docs/makers" },
  { label: "Source on GitHub", href: "https://github.com/ArhamKhan117/hushd" },
];

export function Landing() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main id="main">
        {/* hero: owns the first screen, aligned to the nav container */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="hd-panel flex min-h-[max(520px,calc(100svh-8rem))] flex-col justify-end px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:h-[calc(100svh-10rem)] lg:max-h-[980px] lg:min-h-[620px] lg:px-14 lg:pb-14">
            <FlowField />
            <div className="relative z-10 max-w-[760px]">
              <p className="t-label inline-flex items-center gap-3">
                Private OTC desk on NEAR testnet
                <span aria-hidden>
                  <SealDots n={3} className="text-faint" />
                </span>
              </p>
              <h1 className="t-display-xl mt-5">Private OTC, run by agents.</h1>
              <p className="mt-6 max-w-[48ch] text-[18px] leading-[1.55] text-soft">
                Say what you want to trade. Maker agents quote inside an enclave, both sides settle privately in one
                call, and you can prove one fact about it to one named reader.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-2">
                <AppLink href="/app" className="btn btn-ink btn-lg">
                  Open the desk
                </AppLink>
                <Link href="/docs" className="hd-arrowlink ml-4 self-center">
                  Read the docs <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <a
              href="#how"
              className="hd-glass absolute bottom-8 right-8 z-10 hidden h-10 items-center gap-2 rounded-xl px-4 text-[13.5px] text-foreground transition-colors hover:bg-panel/70 sm:inline-flex lg:bottom-14 lg:right-14"
            >
              How a deal works <span aria-hidden>↓</span>
            </a>
          </div>
        </section>

        {/* what Hushd is: one product you use, build on and can check */}
        <section aria-labelledby="what-hushd-is" className="mx-auto max-w-[1400px] px-4 pt-16 sm:px-7 sm:pt-24">
          <h2 id="what-hushd-is" className="sr-only">
            What Hushd is
          </h2>
          <div className="grid gap-10 sm:grid-cols-3">
            {WHAT.map((w) => {
              const To = w.href.startsWith("/app") ? AppLink : Link;
              return (
                <div key={w.label} className="flex flex-col border-t border-foreground pt-5">
                  <p className="t-label">{w.label}</p>
                  <p className="mt-3 text-[19px] leading-snug tracking-[-0.01em]">{w.title}</p>
                  <p className="mt-2 max-w-[38ch] text-[14px] leading-relaxed text-mute">{w.body}</p>
                  <To href={w.href} className="hd-arrowlink mt-auto pt-4">
                    {w.cta} <span aria-hidden>→</span>
                  </To>
                </div>
              );
            })}
          </div>
        </section>

        {/* thesis + signature */}
        <section aria-labelledby="thesis" className="pb-6 pt-24 sm:pt-36">
          <div className="mx-auto max-w-[900px] px-6 text-center">
            <h2 id="thesis" className="t-display-l">
              Ask for size in public and the price moves. Hushd seals the ask.
            </h2>
            <p className="mx-auto mt-6 max-w-[58ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
              On a public chain, an OTC request tells the market what you are about to do. On Hushd it is sealed to an
              enclave before it leaves your browser. Makers see the pair, the side and the size, never your limit, and
              the chain records a hash.
            </p>
          </div>
          <div className="mt-12">
            <SealStream />
          </div>
          <div className="mx-auto mt-6 flex max-w-[900px] justify-between gap-6 px-6 text-[12px] text-mute sm:px-24">
            <span>What you ask</span>
            <span className="text-right">What the chain records</span>
          </div>
        </section>

        {/* how a deal works, and the desk live */}
        <section id="how" aria-labelledby="how-title" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 pb-10 pt-20 sm:px-7 sm:pb-16 sm:pt-32">
          <div className="hd-panel overflow-clip bg-surface px-5 py-12 sm:px-10 sm:py-16">
            <SealedField tone="soft" />
            <div className="relative mx-auto max-w-[720px] text-center">
              <h2 id="how-title" className="t-display-l">
                How a deal works
              </h2>
              <p className="mx-auto mt-4 max-w-[52ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
                Four steps, each checked on chain. Who traded and how much stay private. The maker and the outcome are
                on the record.
              </p>
            </div>
            <ol className="relative mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map((s) => (
                <li key={s.n} className="flex flex-col rounded-[16px] bg-panel p-5 shadow-card">
                  <span className="t-label tnum">Step {s.n}</span>
                  <span className="mt-4 text-[18px] leading-snug tracking-[-0.01em] text-foreground">{s.title}</span>
                  <span className="mt-2 text-[14px] leading-relaxed text-mute">{s.body}</span>
                </li>
              ))}
            </ol>
            <div className="relative mx-auto mt-10 max-w-[960px]">
              <p className="mb-3 text-center text-[13px] text-mute">The desk, as the chain sees it</p>
              <LiveDesk />
            </div>
            <div className="relative mt-8 flex justify-center">
              <Link href="/docs/desk" className="hd-arrowlink">
                The desk in detail <span aria-hidden>→</span>
              </Link>
            </div>
          </div>
        </section>

        {/* packages */}
        <section aria-labelledby="packages" className="mx-auto max-w-[1400px] px-4 py-20 sm:px-7 sm:py-32">
          <div className="max-w-[720px]">
            <h2 id="packages" className="t-display-l">
              One request, one package, one receipt
            </h2>
            <p className="mt-5 max-w-[56ch] text-[17px] leading-[1.6] text-mute sm:text-[19px]">
              A deal can have more than one leg. Makers quote the whole package, and it settles and is recorded as one.
            </p>
          </div>
          <div className="-mx-4 mt-10 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0 sm:pb-0 [&::-webkit-scrollbar]:hidden">
            {PACKAGES.map((p) => (
              <Link
                key={p.title}
                href={p.href}
                className="hd-tile group flex min-h-[240px] w-[78%] shrink-0 snap-start flex-col p-6 transition-colors hover:bg-surface-2 sm:w-auto"
              >
                {p.icon}
                <div className="mt-auto pt-10">
                  <p className="text-[19px] leading-snug tracking-[-0.01em] text-foreground">{p.title}</p>
                  <p className="mt-2 text-[14px] leading-relaxed text-mute">{p.body}</p>
                </div>
              </Link>
            ))}
          </div>
          <p className="mt-8 max-w-[70ch] text-[15px] leading-relaxed text-mute">
            <span className="text-foreground">When a hedge misses.</span> The maker posts a bond on chain for every
            hedged deal. If the hedge misses its deadline, the bond is paid to you as a private note, and only your
            per-deal key can close the hedge.{" "}
            <Link href="/docs/packages" className="text-foreground underline-offset-4 hover:underline">
              Packages and settlement <span aria-hidden>→</span>
            </Link>
          </p>
        </section>

        {/* proofs to one named reader */}
        <section id="proofs" aria-labelledby="proofs-title" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 sm:px-7">
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="hd-tile flex flex-col justify-between rounded-[24px] p-7 sm:p-10">
              <div>
                <h2 id="proofs-title" className="t-display-l max-w-[14ch]">
                  Prove one fact to one reader
                </h2>
                <p className="mt-5 max-w-[46ch] text-[17px] leading-[1.6] text-mute sm:text-[18px]">
                  An auditor, a counterparty or a fund admin may need to see one thing. Make a proof for their NEAR
                  account, with an expiry, and show them that and nothing else.
                </p>
              </div>
              <div className="mt-10">
                <ul className="divide-y divide-line border-y border-line text-[15px]">
                  {PROOFS.map(([k, v]) => (
                    <li key={k} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-4">
                      <span>{k}</span>
                      <span className="text-mute">{v}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-8 flex flex-wrap gap-2">
                  <AppLink href="/app/prove" className="btn btn-ink">
                    Make a proof
                  </AppLink>
                  <Link href="/docs/proofs" className="btn btn-quiet">
                    How proofs work
                  </Link>
                </div>
              </div>
            </div>
            <div className="hd-panel flex min-h-[500px] items-center justify-center px-4 py-10 sm:px-10">
              <SealedField drift />
              <div className="hd-glass relative w-full max-w-[420px] p-2 shadow-pop">
                <div className="rounded-[12px] bg-panel p-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="t-label">What the reader checks</p>
                    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-sealed">
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sealed" />
                      One reader
                    </span>
                  </div>
                  <dl className="mt-4 divide-y divide-line text-[14px]">
                    {[
                      ["Made for", "One NEAR account, named in the proof"],
                      ["Expires", "On the date you set"],
                      ["Shows", "The one fact you chose"],
                      ["Checked", "In the browser, then by the pool contract"],
                    ].map(([k, v]) => (
                      <div key={k} className="grid gap-1 py-3 sm:grid-cols-[96px_1fr] sm:gap-4">
                        <dt className="text-mute">{k}</dt>
                        <dd className="text-foreground">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-[10px] bg-surface px-3.5 py-2.5 text-[13px]">
                    <span className="text-mute">Everything else</span>
                    <span className="inline-flex items-center gap-2 text-foreground">
                      Hidden <SealDots n={4} className="text-foreground/60" label="Hidden" />
                    </span>
                  </div>
                  <Link href="/verify" className="hd-arrowlink mt-5">
                    Check a proof <span aria-hidden>→</span>
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* agents */}
        <section aria-labelledby="agents-title" className="mx-auto max-w-[1400px] px-4 pb-20 pt-20 sm:px-7 sm:pb-32 sm:pt-32">
          <div className="theme-dark hd-panel grid gap-10 border border-transparent bg-background px-6 py-12 text-foreground dark:border-line dark:bg-panel sm:px-12 sm:py-16 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div className="relative min-w-0">
              <p className="t-label">For agents</p>
              <h2 id="agents-title" className="t-display-l mt-4 max-w-[15ch] text-foreground">
                Agents trade inside limits you set
              </h2>
              <p className="mt-5 max-w-[48ch] text-[17px] leading-[1.6] text-mute sm:text-[18px]">
                The Hushd MCP server gives an agent its own private balance and a seat at the desk. It proves every
                payment on its own machine, refuses anything over its limits, and can pay for HTTP resources over
                private x402.
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                <Link href="/agents" className="btn btn-ink">
                  Hushd for agents
                </Link>
                <Link href="/docs/agents" className="btn btn-quiet">
                  MCP guide <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <div className="relative min-w-0">
              <CodeBlock code={AGENT_SNIPPET} lang="bash" title="MCP server" meta="Terminal" className="bg-surface" />
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[13.5px]">
                {DEV_LINKS.map((l) =>
                  l.href.startsWith("http") ? (
                    <a
                      key={l.label}
                      href={l.href}
                      target="_blank"
                      rel="noreferrer"
                      className="hd-tap inline-flex items-center gap-1.5 text-soft transition-colors hover:text-foreground"
                    >
                      {l.label} <ArrowUpRight />
                    </a>
                  ) : (
                    <Link key={l.label} href={l.href} className="hd-tap text-soft transition-colors hover:text-foreground">
                      {l.label}
                    </Link>
                  ),
                )}
              </div>
            </div>
          </div>
        </section>

        {/* only on NEAR */}
        <section aria-labelledby="near" className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-7 sm:pb-32">
          <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 id="near" className="t-display-l max-w-[11ch]">
                Only on NEAR
              </h2>
              <p className="mt-5 max-w-[38ch] text-[15px] leading-relaxed text-mute">
                Hushd leans on things NEAR has built in. Each of these is part of how a deal runs today.
              </p>
            </div>
            <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2 xl:grid-cols-3">
              {NEAR_ONLY.map((n) => (
                <div key={n.title} className="border-t border-foreground pt-5">
                  <p className="text-[18px] leading-snug tracking-[-0.01em]">{n.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{n.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* honest limits */}
        <section aria-labelledby="limits" className="mx-auto max-w-[1400px] px-4 sm:px-7">
          <div className="grid gap-12 lg:grid-cols-[1fr_2fr]">
            <div>
              <h2 id="limits" className="t-display-l max-w-[11ch]">
                Honest about where it is
              </h2>
              <div className="mt-6 flex flex-col items-start gap-3">
                <Link href="/docs/privacy-model" className="hd-arrowlink">
                  The privacy model <span aria-hidden>→</span>
                </Link>
                <Link href="/docs/threat-model" className="hd-arrowlink">
                  The threat model <span aria-hidden>→</span>
                </Link>
              </div>
            </div>
            <div className="grid gap-x-10 gap-y-10 sm:grid-cols-2 xl:grid-cols-3">
              {LIMITS.map((t) => (
                <div key={t.title} className="border-t border-foreground pt-5">
                  <p className="text-[18px] leading-snug tracking-[-0.01em]">{t.title}</p>
                  <p className="mt-3 text-[14px] leading-relaxed text-mute">{t.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* the way in */}
        <section aria-labelledby="start" className="mx-auto max-w-[1400px] px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="hd-panel flex min-h-[420px] flex-col justify-end px-6 pb-10 pt-24 sm:px-12 sm:pb-14">
            <FlowField />
            <div className="relative z-10 max-w-[720px]">
              <h2 id="start" className="t-display-l">
                Try a private deal on testnet
              </h2>
              <p className="mt-5 max-w-[50ch] text-[17px] leading-[1.6] text-soft">
                Sign in with a NEAR wallet or a passkey, get test tokens from the faucet, add them privately and ask
                the desk. Everything runs on test tokens with no value.
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                <AppLink href="/app" className="btn btn-ink btn-lg">
                  Open the desk
                </AppLink>
                <Link href="/docs/quickstart" className="btn btn-ghost btn-lg">
                  Read the quickstart
                </Link>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
