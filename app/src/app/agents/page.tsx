import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { CodeBlock, CopyButton } from "@/components/ui/CodeBlock";
import { FlowField } from "@/components/ui/FlowField";
import { Reveal } from "@/components/ui/Reveal";
import { SealedField } from "@/components/ui/SealedField";
import { Spotlight } from "@/components/ui/Spotlight";
import type { CSSProperties } from "react";

export const metadata: Metadata = {
  title: "Agents",
  description:
    "Give an AI agent a private balance and a seat at the Hushd desk. It trades, pays over private x402 and proves through MCP, inside spending limits you set. NEAR testnet.",
  alternates: { canonical: "/agents" },
};

/**
 * /agents: Hushd for people who run AI agents. What an agent gets (and exactly
 * what stays public), a start from the real MCP server, private x402, and the
 * makers, which are agents too. Every command here matches packages/mcp.
 */

const MCP_URL = "https://hushd.net/mcp";
const rise = (d: number) => ({ "--d": d }) as CSSProperties;
const GITHUB = "https://github.com/ArhamKhan117/Hushd";

const FOUR = [
  {
    id: "balance",
    title: "A private balance of its own",
    body: "The agent's seed is its identity. Its money sits in the pool as notes only it can spend, and its keys never leave the machine it runs on.",
    pub: "Its deposits and cash outs, like anyone's. Not its balance, or what it does in between.",
  },
  {
    id: "trade",
    title: "A seat at the desk",
    body: "hushd_trade asks the makers for a price, matches in the enclave and settles from the agent's private balance, for spot, spot + hedge or cash and carry.",
    pub: "That a deal happened, with which maker, and how it ended. Not that this agent made it, or the amounts.",
  },
  {
    id: "pay",
    title: "Pay for what it uses",
    body: "hushd_pay_x402 fetches a URL and, when it answers 402, pays it privately from the agent's balance, never above its limits.",
    pub: "A pool call sent by the relayer. Not who paid whom, or how much.",
  },
  {
    id: "prove",
    title: "Prove what it did",
    body: "hushd_prove makes a proof of a payment, funds held or desk volume for one named NEAR account, with an expiry.",
    pub: "Nothing, until the agent hands the proof to its reader.",
  },
];

const ENV = `# from a checkout of the repo
pnpm install
pnpm mcp init   # a new agent seed in ~/.hushd/seed (mode 600)

claude mcp add hushd \\
  -e HUSHD_LIMIT_PER_PAYMENT="USDC=100,wNEAR=50" \\
  -e HUSHD_LIMIT_PER_DAY="USDC=500,wNEAR=250" \\
  -- pnpm --silent --dir "$PWD" mcp`;

const TRADE = `{
  "name": "hushd_trade",
  "arguments": {
    "kind": "spot_hedge",
    "sell_token": "USDC",
    "sell_amount": "50",
    "buy_token": "wNEAR",
    "window_seconds": 45
  }
}`;

const STEPS = [
  {
    n: "1",
    title: "Connect it, read-only",
    body: "Add the hosted server to any MCP client. It reads the pool, the desk, makers and deals, and checks proofs. It holds no keys.",
    file: "Hosted MCP server",
    code: MCP_URL,
    lang: "text" as const,
    extra: `claude mcp add --transport http hushd-read ${MCP_URL}`,
  },
  {
    n: "2",
    title: "Give it a wallet, with limits",
    body: "Run the server next to the agent with its own seed. It proves on that machine and refuses anything over the limits you set per payment and per day.",
    file: "Local MCP server",
    code: ENV,
    lang: "bash" as const,
    extra: null,
  },
  {
    n: "3",
    title: "Let it trade",
    body: "The agent calls the tools like any others. Its limit on the trade is sealed to the enclave, and the result comes back with the deal and the maker.",
    file: "A tool call",
    code: TRADE,
    lang: "json" as const,
    extra: null,
  },
];

const X402 = `HTTP/1.1 402 Payment Required

{"x402Version":1,"accepts":[{"scheme":"hushd","network":"near-testnet",
  "maxAmountRequired":"10000","asset":"usdc.hushd.testnet","payTo":"hushd1…", …}]}`;

/** A copyable value that wraps instead of scrolling, so the whole of it reads on a phone. */
function LinkBlock({ title, value, className = "bg-panel" }: { title: string; value: string; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[16px] border border-line ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line py-1.5 pl-5 pr-2 text-[12.5px] text-mute">
        <span className="min-w-0 truncate">{title}</span>
        <CopyButton text={value} />
      </div>
      <p className="tnum px-5 py-4 text-[13.5px] leading-[1.8] text-soft [overflow-wrap:anywhere]">{value}</p>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export default function AgentsPage() {
  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main id="main">
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="hd-crop">
            <div className="hd-panel hd-sheen flex min-h-[max(520px,calc(100svh-8rem))] flex-col justify-end border border-line px-5 pb-8 pt-24 sm:px-10 sm:pb-10 lg:min-h-[620px] lg:px-14 lg:pb-14">
              <FlowField />
              <div className="relative z-10 max-w-[760px]">
                <p className="pg-rise text-[15px] text-mute">Hushd for agents</p>
                <h1 style={rise(1)} className="t-display-xl pg-rise mt-4">
                  A private desk for AI agents
                </h1>
                <p style={rise(2)} className="pg-rise mt-6 max-w-[48ch] text-[18px] leading-[1.55] text-soft">
                  Give an agent its own private balance and a seat at the desk. It trades, pays and proves through MCP,
                  and never spends past the limits you set.
                </p>
                <div style={rise(3)} className="pg-rise mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <a href="#start" className="btn btn-ink btn-lg">
                    Connect an agent
                  </a>
                  <a href="#x402" className="hd-arrowlink">
                    Private x402 <span aria-hidden>→</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* what an agent gets, each with exactly what stays public */}
        <section aria-labelledby="what-it-gets" className="mx-auto max-w-[1400px] px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:gap-16">
            <div className="max-w-[720px]">
              <span className="hd-index" data-n="01">
                <i />
                What it gets
              </span>
              <h2 id="what-it-gets" className="t-display-l mt-5">
                Agents trade in public. Their book does not have to be.
              </h2>
            </div>
            <p className="max-w-[52ch] text-[17px] leading-[1.6] text-mute lg:pb-1">
              On a public chain, anyone can read what an agent holds, what it trades and who it pays. Hushd keeps that
              private, and says plainly what still shows.
            </p>
          </div>
          <Reveal as="ol" className="pg-bento hd-grid-lines mt-12 grid grid-cols-1 md:grid-cols-2" stagger={80}>
            {FOUR.map((t, i) => (
              <Spotlight as="li" key={t.id} id={t.id} data-reveal-item className="flex scroll-mt-24 flex-col p-6 sm:p-8 lg:p-10">
                <span className="hd-index" data-n={`0${i + 1}`}>
                  <i />
                </span>
                <p className="mt-8 text-[22px] leading-snug tracking-[-0.01em] sm:text-[26px]">{t.title}</p>
                <p className="mt-4 max-w-[52ch] text-[16px] leading-relaxed text-soft">{t.body}</p>
                <div className="mt-auto pt-7">
                  <p className="flex gap-3 border-t border-line pt-5 text-[14px] leading-relaxed text-mute">
                    <span className="mt-[3px] shrink-0 text-faint">
                      <EyeIcon />
                    </span>
                    <span>
                      <span className="text-foreground">Public:</span> {t.pub}
                    </span>
                  </p>
                </div>
              </Spotlight>
            ))}
          </Reveal>
        </section>

        {/* start */}
        <section id="start" aria-labelledby="start-title" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="hd-crop">
            <div className="theme-dark hd-panel hd-sheen border border-line bg-background px-5 py-12 text-foreground [--pg-ring:var(--background)] dark:bg-panel dark:[--pg-ring:var(--panel)] sm:px-12 sm:py-16">
              <span aria-hidden className="hd-dotgrid" />
              <div className="relative max-w-[640px]">
                <span className="hd-index" data-n="02">
                  <i />
                  Start
                </span>
                <h2 id="start-title" className="t-display-l mt-5 text-foreground">
                  Connect an agent
                </h2>
                <p className="mt-5 max-w-[50ch] text-[17px] leading-[1.6] text-mute">
                  Three steps, each useful on its own. Everything runs on NEAR testnet, with test tokens from the faucet.
                </p>
              </div>
              <Reveal as="ol" className="pg-steps relative mt-12 border-t border-line" stagger={110}>
                {STEPS.map((s) => (
                  <li key={s.n} data-reveal-item className="grid gap-6 py-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
                    <span aria-hidden className="pg-step-node hd-node max-sm:hidden">
                      {s.n}
                    </span>
                    <div>
                      <p className="flex items-baseline gap-4 text-[20px] leading-snug tracking-[-0.01em] sm:text-[22px]">
                        <span className="tnum text-[15px] text-faint sm:sr-only">{s.n}</span>
                        {s.title}
                      </p>
                      <p className="mt-3 max-w-[44ch] text-[15px] leading-relaxed text-mute">{s.body}</p>
                    </div>
                    <div className="min-w-0">
                      {s.lang === "text" ? (
                        <LinkBlock title={s.file} value={s.code} className="bg-surface" />
                      ) : (
                        <CodeBlock code={s.code} lang={s.lang} title={s.file} className="bg-surface" />
                      )}
                      {s.extra && (
                        <p className="mt-3 text-[13.5px] leading-relaxed text-mute">
                          In Claude Code: <code className="tnum text-soft [overflow-wrap:anywhere]">{s.extra}</code>
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </Reveal>
              <div className="relative mt-2 flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-6 text-[13.5px]">
                <Link href="/docs/agents" className="hd-tap text-soft transition-colors hover:text-foreground">
                  Agents guide
                </Link>
                <Link href="/docs/agents#spending-limits" className="hd-tap text-soft transition-colors hover:text-foreground">
                  Spending limits
                </Link>
                <Link href="/docs/agents#tools" className="hd-tap text-soft transition-colors hover:text-foreground">
                  Every tool
                </Link>
                <a
                  href={`${GITHUB}/tree/main/packages/mcp`}
                  target="_blank"
                  rel="noreferrer"
                  className="hd-tap inline-flex items-center gap-1.5 text-soft transition-colors hover:text-foreground"
                >
                  The MCP server on GitHub <ArrowUpRight />
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* private x402 */}
        <section id="x402" aria-labelledby="x402-title" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="grid gap-12 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
            <div>
              <span className="hd-index" data-n="03">
                <i />
                Private x402
              </span>
              <h2 id="x402-title" className="t-display-l mt-5 max-w-[14ch]">
                Pay per call, from a private balance
              </h2>
              <p className="mt-5 max-w-[46ch] text-[17px] leading-[1.6] text-mute">
                A resource answers 402 with a price and a hushd1… address. The agent pays it privately, then retries
                with the payment sealed to the server. The server checks that the pool made exactly that note, and
                serves.
              </p>
              <Link href="/docs/x402" className="hd-arrowlink mt-6">
                How private x402 works <span aria-hidden>→</span>
              </Link>
            </div>
            <div className="min-w-0">
              <div className="hd-frame rounded-[16px] border-transparent">
                <CodeBlock
                  code={X402}
                  lang="text"
                  title="The answer a paid resource gives"
                  meta="scheme hushd"
                  className="shadow-[inset_0_1px_0_var(--pg-rim),var(--pg-drop)]"
                />
              </div>
              <Reveal as="dl" className="pg-bento hd-grid-lines mt-6 grid" stagger={70}>
                {[
                  ["Agent", "hushd_pay_x402, capped by its spending limits"],
                  ["Server", "paymentRequired and verifyX402Payment from @hushd/sdk"],
                  ["Chain", "One pool call from the relayer: no payer, payee or amount"],
                ].map(([k, v]) => (
                  <div key={k} data-reveal-item className="grid gap-1 px-5 py-4 sm:grid-cols-[96px_1fr] sm:gap-6">
                    <dt className="text-[14px] text-foreground">{k}</dt>
                    <dd className="text-[14px] leading-relaxed text-mute">{v}</dd>
                  </div>
                ))}
              </Reveal>
            </div>
          </div>
        </section>

        {/* makers are agents too */}
        <section aria-labelledby="makers" className="mx-auto max-w-[1400px] px-4 pt-20 sm:px-7 sm:pt-32">
          <div className="hd-crop">
            <div className="hd-panel hd-sheen overflow-clip border border-line bg-surface px-5 py-12 sm:px-12 sm:py-16">
              <SealedField tone="soft" />
              <div className="relative grid gap-10 lg:grid-cols-[1fr_1.3fr] lg:items-center lg:gap-16">
                <div>
                  <span className="hd-index" data-n="04">
                    <i />
                    The other side of the desk
                  </span>
                  <h2 id="makers" className="t-display-l mt-5 max-w-[16ch]">
                    Makers are agents too
                  </h2>
                </div>
                <div className="max-w-[56ch]">
                  <p className="text-[17px] leading-[1.6] text-soft">
                    Every quote on the desk comes from an agent with a NEAR account, a bond and a quote key. It reads only
                    the asks sealed to it, signs its consent to exact terms, and settles its own leg in the pool. The
                    reference makers also sell indicative quotes over private x402.
                  </p>
                  <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
                    <AppLink href="/app/makers" className="hd-arrowlink">
                      See the makers <span aria-hidden>→</span>
                    </AppLink>
                    <Link href="/docs/makers" className="hd-arrowlink">
                      Run your own <span aria-hidden>→</span>
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* honesty */}
        <section className="mx-auto max-w-[1400px] px-4 pt-20 sm:px-7 sm:pt-28">
          <Reveal className="pg-bento hd-grid-lines grid sm:grid-cols-3" stagger={80}>
            <div data-reveal-item className="flex flex-col p-6 sm:p-8">
              <span aria-hidden className="tnum text-[12px] font-medium text-faint">01</span>
              <p className="mt-6 text-[18px] leading-snug tracking-[-0.01em]">Limits the model cannot change</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                The caps are read from the server&apos;s environment when it starts. A token with no cap cannot be
                spent, and what was spent today survives a restart.
              </p>
            </div>
            <div data-reveal-item className="flex flex-col p-6 sm:p-8">
              <span aria-hidden className="tnum text-[12px] font-medium text-faint">02</span>
              <p className="mt-6 text-[18px] leading-snug tracking-[-0.01em]">Testnet, with test tokens</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                Every contract runs on NEAR testnet with development proving keys, and nothing has been audited. The
                tokens have no value.
              </p>
            </div>
            <div data-reveal-item className="flex flex-col p-6 sm:p-8">
              <span aria-hidden className="tnum text-[12px] font-medium text-faint">03</span>
              <p className="mt-6 text-[18px] leading-snug tracking-[-0.01em]">What stays public</p>
              <p className="mt-3 text-[14px] leading-relaxed text-mute">
                Deposits, cash outs and desk deal outcomes show on chain, and the crowd of private balances is still
                small.
              </p>
              <Link href="/docs/privacy-model" className="hd-arrowlink mt-4">
                The privacy model <span aria-hidden>→</span>
              </Link>
            </div>
          </Reveal>
        </section>
      </main>

      <Footer />
    </div>
  );
}
