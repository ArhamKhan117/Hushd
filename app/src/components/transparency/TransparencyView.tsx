"use client";

import { accountUrl, deskView, poolView, type AssetView, type PoolStats } from "@hushd/sdk";
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { FlowField } from "@/components/ui/FlowField";
import { SealedField } from "@/components/ui/SealedField";
import { NETWORK } from "@/lib/hushd/config";
import { fmt, symbol } from "@/lib/hushd/format";
import { intentsTrades, type IntentsTrades } from "@/lib/hushd/intents";

/**
 * /transparency: what anyone can see about Hushd, read live in the browser. The
 * services' health comes from the Hushd API, the counts and holdings from the
 * contracts on NEAR testnet. Anything that cannot be read says so, and no number
 * is ever shown in its place.
 */

const API = NETWORK.api.replace(/\/$/, "");
const SERVICES = ["relayer", "indexer", "matcher", "makers", "keeper", "topup"] as const;
const SERVICE_WORDS: Record<string, string> = {
  api: "Reads for the app, sealed request intake and deal rooms",
  relayer: "Sends proven actions from its own account",
  indexer: "Reads Hushd's events from the block stream",
  matcher: "Carries sealed batches to the enclave",
  makers: "The three reference makers",
  keeper: "Expires deals, runs hedge legs, records receipts",
  topup: "Keeps the service accounts funded",
};

const intFmt = new Intl.NumberFormat("en-US");

type Health = { state: "ok" | "down" | "unreachable"; uptimeS?: number; detail?: string };
type Status = {
  balances: { account: string; balance: string | null }[];
  treasury: string | null;
  treasuryLow: boolean | null;
} | null;

async function getJson(url: string): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok, body };
}

async function health(path: string): Promise<Health> {
  try {
    const r = await getJson(`${API}${path}`);
    if (r.ok && r.body?.ok === true) return { state: "ok", ...(typeof r.body.uptimeS === "number" ? { uptimeS: r.body.uptimeS } : {}) };
    return { state: "down", detail: typeof r.body?.error === "string" ? r.body.error : undefined };
  } catch {
    return { state: "unreachable" };
  }
}

function uptime(s: number): string {
  if (s < 3600) return `up ${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `up ${Math.round(s / 3600)} h`;
  return `up ${Math.round(s / 86_400)} d`;
}

function near(yocto: string | null): string {
  if (yocto === null) return "Unknown";
  const n = Number(BigInt(yocto) / 10n ** 20n) / 10_000;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} NEAR`;
}

/* ---------------------------------------------------------------- data */

type ServicesState = { loading: boolean; api: Health | null; services: Record<string, Health>; status: Status; at: number | null };

function useServices() {
  const [s, setS] = useState<ServicesState>({ loading: true, api: null, services: {}, status: null, at: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    const run = async () => {
      const [api, ...rest] = await Promise.all([health("/health"), ...SERVICES.map((x) => health(`/health/${x}`))]);
      const status = await getJson(`${API}/v1/status`)
        .then((r) => (r.ok && r.body ? (r.body as unknown as NonNullable<Status>) : null))
        .catch(() => null);
      if (!live) return;
      setS({ loading: false, api, services: Object.fromEntries(SERVICES.map((x, i) => [x, rest[i]!])), status, at: Date.now() });
    };
    void run();
    return () => {
      live = false;
    };
  }, [nonce]);
  const refresh = useCallback(() => {
    setS((p) => ({ ...p, loading: true }));
    setNonce((n) => n + 1);
  }, []);
  return { ...s, refresh };
}

type DeskStats = { rfqs: number; deals: number; settled: number; recovered: number; failed: number; unresolved: number };
type ChainState =
  | { status: "loading" }
  | { status: "ready"; pool: PoolStats; assets: AssetView[]; desk: DeskStats; makers: number }
  | { status: "missing"; account: string }
  | { status: "error" };

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);

function useChain() {
  const [s, setS] = useState<ChainState>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([poolView.stats(NETWORK), poolView.assets(NETWORK), deskView.stats(NETWORK), deskView.makers(NETWORK)])
      .then(([pool, assets, d, makers]) => {
        if (!live) return;
        const r = d ?? {};
        setS({
          status: "ready",
          pool,
          assets,
          makers: makers.length,
          desk: { rfqs: num(r.rfqs), deals: num(r.deals), settled: num(r.settled), recovered: num(r.recovered), failed: num(r.failed), unresolved: num(r.unresolved) },
        });
      })
      .catch((e: Error) => {
        if (!live) return;
        const m = /^(\S+) does not exist/.exec(e.message ?? "");
        if (/UNKNOWN_ACCOUNT/.test(e.message ?? "")) setS({ status: "missing", account: m?.[1] ?? NETWORK.pool ?? "The pool" });
        else setS({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [nonce]);
  const refresh = useCallback(() => {
    setS({ status: "loading" });
    setNonce((n) => n + 1);
  }, []);
  return { state: s, refresh };
}

type TradesState = { status: "loading" } | { status: "ready"; record: IntentsTrades } | { status: "error" };

function useIntentsTrades() {
  const [s, setS] = useState<TradesState>({ status: "loading" });
  useEffect(() => {
    let live = true;
    intentsTrades().then(
      (record) => live && setS({ status: "ready", record }),
      () => live && setS({ status: "error" }),
    );
    return () => {
      live = false;
    };
  }, []);
  return s;
}

/* ---------------------------------------------------------------- pieces */

function LockIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function EyeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function Dot({ state }: { state: Health["state"] | "loading" }) {
  const c = state === "ok" ? "bg-accent livedot" : state === "down" ? "bg-danger" : state === "unreachable" ? "bg-warn" : "bg-line-strong";
  return <span aria-hidden className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${c}`} />;
}

function stateWords(h: Health | undefined, loading: boolean): string {
  if (!h) return loading ? "Checking…" : "Unknown";
  if (h.state === "ok") return h.uptimeS !== undefined ? `Healthy, ${uptime(h.uptimeS)}` : "Healthy";
  if (h.state === "down") return "Not healthy";
  return "Not reachable";
}

function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="hd-card min-w-0 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="t-title">{title}</h3>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Notice({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-[14px] bg-surface px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div>
        <p className="text-[15px] text-foreground">{title}</p>
        <p className="mt-1 max-w-[60ch] text-[13.5px] leading-relaxed text-mute">{children}</p>
      </div>
      {action}
    </div>
  );
}

function Count({ label, value, sealed = false }: { label: string; value: number; sealed?: boolean }) {
  return (
    <div className="flex min-h-[92px] flex-col justify-between rounded-[14px] bg-surface p-4">
      <span className="flex items-center justify-between gap-2 text-[12.5px] text-mute">
        {label}
        {sealed && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sealed" />}
      </span>
      <span className="tnum mt-3 text-[26px] font-light leading-none tracking-[-0.02em] text-foreground">{intFmt.format(value)}</span>
    </div>
  );
}

const CONTRACTS: { account: string; what: string }[] = [
  ...(NETWORK.pool ? [{ account: NETWORK.pool, what: "Shielded pool" }] : []),
  ...(NETWORK.desk ? [{ account: NETWORK.desk, what: "OTC desk" }] : []),
  ...(NETWORK.board ? [{ account: NETWORK.board, what: "Encrypted board" }] : []),
  ...NETWORK.tokens.map((t) => ({ account: t.id, what: `Test ${t.symbol}` })),
];

const PRIVATE_FACTS = [
  {
    title: "Who paid whom",
    body: "A private transfer shows two new notes and two spent ones, sent by the relayer. Not the sender, the recipient or the amount.",
  },
  {
    title: "Your balance",
    body: "Notes are commitments. Without the owner's key, nobody can tell whose they are or what they hold.",
  },
  {
    title: "Your limit",
    body: "A request goes on chain as a hash. Your limit and your words are opened only inside the matcher enclave.",
  },
  {
    title: "Who traded",
    body: "A desk deal records its maker and its outcome. It does not record the trader, or the amounts.",
  },
];

const STEP_WORDS: Record<string, string> = {
  fund: "Fund the agents",
  "deposit-trader": "The trader deposits",
  "deposit-maker": "The maker deposits",
  swap: "A swap through 1Click",
  trade: "The direct trade",
  withdraw: "Both withdraw",
  return: "Back to the dev wallet",
};
const stepWords = (step: string) => STEP_WORDS[step] ?? step.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const sentence = (s: string) => s.replace(/^./, (c) => c.toUpperCase());
const shortHash = (h: string) => (h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);
const MAINNET_TX = "https://nearblocks.io/txns/";

/* ---------------------------------------------------------------- view */

export function TransparencyView() {
  const svc = useServices();
  const chain = useChain();
  const trades = useIntentsTrades();

  const apiDown = !svc.loading && svc.api?.state !== "ok";

  return (
    <div className="relative min-h-screen bg-panel text-foreground">
      <Header />

      <main id="main">
        {/* hero */}
        <section className="mx-auto max-w-[1400px] px-4 pt-3 sm:px-7 sm:pt-6">
          <div className="hd-panel flex min-h-[520px] flex-col justify-end gap-12 px-6 pb-8 pt-24 sm:px-12 sm:pb-12 lg:min-h-[580px]">
            <FlowField />
            <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-14">
              <div className="max-w-[720px]">
                <h1 className="t-display-xl">What anyone can see</h1>
                <p className="mt-6 max-w-[52ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                  Hushd keeps who traded, who paid whom and how much private. The contracts and the services that run
                  the desk are public. This page reads them live, in your browser, so you can see exactly what is out
                  in the open.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 lg:pb-1">
                <a href="#services" className="btn btn-ink btn-lg">
                  See the services
                </a>
                <a href="#private" className="hd-arrowlink">
                  What stays private <span aria-hidden>→</span>
                </a>
              </div>
            </div>

            <div className="hd-glass relative w-full p-2">
              <div className="rounded-[12px] bg-panel">
                <p className="px-5 pt-4 text-[13px] text-mute sm:px-6">What the chain shows</p>
                <ul className="grid grid-cols-1 divide-y divide-line px-5 sm:px-6 lg:grid-cols-4 lg:divide-x lg:divide-y-0 lg:px-0 lg:pb-2">
                  {(
                    [
                      ["Deposits, cash outs", "Public, with amounts", false],
                      ["Desk deals", "Public, with outcomes", false],
                      ["Private transfers", "Count only", true],
                      ["Amounts in the pool", "Hidden", true],
                    ] as const
                  ).map(([k, v, sealed]) => (
                    <li key={k} className="flex min-h-[52px] items-center justify-between gap-4 py-2 text-[14px] lg:block lg:min-h-0 lg:px-6 lg:py-3">
                      <span className="text-mute lg:block">{k}</span>
                      <span className="inline-flex items-center gap-2 text-right text-foreground lg:mt-1.5 lg:text-left lg:text-[17px]">
                        <span
                          aria-hidden
                          className={`grid h-5 w-5 shrink-0 place-items-center rounded-full max-lg:order-2 ${sealed ? "bg-sealed-soft text-sealed" : "bg-surface text-soft"}`}
                        >
                          {sealed ? <LockIcon size={10} /> : <EyeIcon size={11} />}
                        </span>
                        {v}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* services */}
        <section id="services" aria-labelledby="services-title" className="mx-auto max-w-[1240px] scroll-mt-20 px-4 pt-20 sm:px-6 sm:pt-28">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[640px]">
              <h2 id="services-title" className="t-display-l">
                The services, live
              </h2>
              <p className="mt-5 max-w-[54ch] text-[16px] leading-relaxed text-mute">
                Each service answers its own health check through the Hushd API at{" "}
                <span className="text-foreground">{API.replace(/^https?:\/\//, "")}</span>. The status also lists what
                each service account holds, so you can see the desk can pay its gas.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {svc.at && !svc.loading && (
                <span className="tnum text-[13px] text-mute">
                  Checked {new Date(svc.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
              <button type="button" onClick={svc.refresh} disabled={svc.loading} className="btn btn-ghost btn-sm">
                {svc.loading ? "Checking…" : "Check again"}
              </button>
            </div>
          </div>

          <div className="mt-10 grid items-start gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <Card title="Health">
              {apiDown && (
                <div className="mb-4">
                  <Notice title="The Hushd API is not answering">
                    {svc.api?.state === "down"
                      ? "It answered, but says it is not healthy. The services behind it may be restarting."
                      : "It could not be reached from your browser just now. The services may not be deployed yet, or may be restarting."}
                  </Notice>
                </div>
              )}
              <ul className="divide-y divide-line border-y border-line">
                {(["api", ...SERVICES] as const).map((name) => {
                  const h = name === "api" ? (svc.api ?? undefined) : svc.services[name];
                  return (
                    <li key={name} className="grid gap-1 py-3 sm:grid-cols-[120px_minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                      <span className="text-[14.5px] text-foreground">{name === "api" ? "API" : name[0]!.toUpperCase() + name.slice(1)}</span>
                      <span className="text-[13px] leading-snug text-mute">{SERVICE_WORDS[name]}</span>
                      <span className="inline-flex items-center gap-2 text-[13px] text-soft sm:justify-end">
                        <Dot state={h ? h.state : "loading"} />
                        {stateWords(h, svc.loading)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Card>

            <Card title="Service accounts">
              {svc.loading && !svc.status ? (
                <div className="grid gap-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="hd-skeleton h-10" />
                  ))}
                </div>
              ) : !svc.status ? (
                <Notice title="No status to show">
                  The account balances come from the API&apos;s status, which is not available right now.
                </Notice>
              ) : svc.status.balances.length === 0 ? (
                <p className="text-[14px] text-mute">The API lists no service accounts.</p>
              ) : (
                <>
                  {svc.status.treasuryLow && (
                    <p role="status" className="mb-3 rounded-xl bg-warn-soft px-4 py-3 text-[13px] leading-relaxed text-warn">
                      The treasury that funds the services is running low.
                    </p>
                  )}
                  <ul className="divide-y divide-line border-y border-line">
                    {svc.status.balances.map((b) => (
                      <li key={b.account} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3 text-[13.5px]">
                        <a
                          href={accountUrl(NETWORK, b.account)}
                          target="_blank"
                          rel="noreferrer"
                          className="hd-tap inline-flex min-w-0 items-center gap-1.5 text-foreground [overflow-wrap:anywhere] hover:underline"
                        >
                          {b.account}
                          {b.account === svc.status!.treasury && <span className="text-mute">(treasury)</span>}
                          <ArrowUpRight className="text-faint" />
                        </a>
                        <span className="tnum text-soft">{near(b.balance)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Card>
          </div>
        </section>

        {/* chain */}
        <section id="chain" aria-labelledby="chain-title" className="mx-auto max-w-[1240px] scroll-mt-20 px-4 pt-20 sm:px-6 sm:pt-28">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-[640px]">
              <h2 id="chain-title" className="t-display-l">
                The contracts, live
              </h2>
              <p className="mt-5 max-w-[54ch] text-[16px] leading-relaxed text-mute">
                Read straight from NEAR testnet RPC. No Hushd server sits in between, and you do not need a wallet.
              </p>
            </div>
            <button type="button" onClick={chain.refresh} disabled={chain.state.status === "loading"} className="btn btn-ghost btn-sm self-start lg:self-auto">
              {chain.state.status === "loading" ? "Reading…" : "Read again"}
            </button>
          </div>

          <div className="mt-10 grid items-start gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <Card title="Counts">
              {chain.state.status === "loading" && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="hd-skeleton h-[92px] rounded-[14px]" />
                  ))}
                </div>
              )}
              {chain.state.status === "missing" && (
                <Notice title="Nothing to count yet">
                  {chain.state.account} is not on NEAR testnet yet. Once the contracts are deployed, their counts show
                  here, read from the chain.
                </Notice>
              )}
              {chain.state.status === "error" && (
                <Notice
                  title="Could not read the chain just now"
                  action={
                    <button type="button" onClick={chain.refresh} className="btn btn-ghost btn-sm shrink-0">
                      Try again
                    </button>
                  }
                >
                  Public NEAR RPC nodes sometimes slow down or limit requests. No number is shown rather than an old
                  one.
                </Notice>
              )}
              {chain.state.status === "ready" && (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Count label="Deposits" value={chain.state.pool.shields} />
                    <Count label="Private transfers" value={chain.state.pool.transfers} sealed />
                    <Count label="Cash outs" value={chain.state.pool.cash_outs} />
                    <Count label="Desk deals" value={chain.state.desk.deals} />
                    <Count label="Settled" value={chain.state.desk.settled} />
                    <Count label="Makers" value={chain.state.makers} />
                  </div>
                  <p className="tnum mt-3 text-[12.5px] leading-relaxed text-mute">
                    Requests opened {intFmt.format(chain.state.desk.rfqs)} · recovered {intFmt.format(chain.state.desk.recovered)} · failed{" "}
                    {intFmt.format(chain.state.desk.failed)} · unresolved {intFmt.format(chain.state.desk.unresolved)} · refund notes{" "}
                    {intFmt.format(chain.state.pool.refunds)}
                  </p>
                </>
              )}
            </Card>

            <Card title="Held by the pool">
              {chain.state.status === "ready" ? (
                chain.state.assets.length === 0 ? (
                  <p className="text-[14px] text-mute">The pool lists no tokens yet.</p>
                ) : (
                  <ul className="divide-y divide-line border-y border-line">
                    {chain.state.assets.map((a) => {
                      const known = NETWORK.tokens.some((t) => t.id === a.token);
                      return (
                        <li key={a.token} className="grid gap-1 py-3 text-[13.5px] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
                          <span className="text-foreground [overflow-wrap:anywhere]">{known ? symbol(a.token) : a.token}</span>
                          <span className="tnum text-soft sm:text-right">
                            {known ? `${fmt(a.token, BigInt(a.held))} held` : `${a.held} base units held`}
                            <span className="block text-[12px] text-mute">
                              {known ? `Up to ${fmt(a.token, BigInt(a.limits.per_deposit))} per deposit` : null}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )
              ) : chain.state.status === "loading" ? (
                <div className="grid gap-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="hd-skeleton h-10" />
                  ))}
                </div>
              ) : (
                <p className="text-[14px] leading-relaxed text-mute">Shown once the pool can be read.</p>
              )}
              <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
                The total each token holds is public, as with any contract. What each note holds, and whose it is, is
                not.
              </p>
            </Card>
          </div>
        </section>

        {/* addresses */}
        <section id="contracts" aria-labelledby="contracts-title" className="mx-auto max-w-[1240px] scroll-mt-20 px-4 pt-20 sm:px-6 sm:pt-28">
          <div className="grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-12">
            <div>
              <h2 id="contracts-title" className="t-display-l max-w-[12ch]">
                The accounts
              </h2>
              <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-mute">
                Every Hushd contract on NEAR testnet. Open each on NearBlocks for its code, transactions and events.
              </p>
              <Link href="/docs/contracts" className="hd-arrowlink mt-6">
                What each one does <span aria-hidden>→</span>
              </Link>
            </div>
            <ul className="divide-y divide-line border-y border-line">
              {CONTRACTS.map((c) => (
                <li key={c.account} className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-3.5">
                  <span className="text-[14px] text-mute">{c.what}</span>
                  <a
                    href={accountUrl(NETWORK, c.account)}
                    target="_blank"
                    rel="noreferrer"
                    className="hd-tap inline-flex min-w-0 items-center gap-1.5 text-[14.5px] text-foreground [overflow-wrap:anywhere] hover:underline"
                  >
                    {c.account} <ArrowUpRight className="text-faint" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* mainnet NEAR Intents */}
        <section id="intents" aria-labelledby="intents-title" className="mx-auto max-w-[1240px] scroll-mt-20 px-4 pt-20 sm:px-6 sm:pt-28">
          <div className="grid gap-10 lg:grid-cols-[1fr_2fr] lg:gap-12">
            <div>
              <h2 id="intents-title" className="t-display-l">
                On NEAR&nbsp;Intents (mainnet)
              </h2>
              <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-mute">
                Two Hushd agents trade with each other on intents.near, with real tokens. Each signs its side of the trade, and one
                call settles both sides or neither. Every transaction is listed here.
              </p>
              <a href="https://nearblocks.io/address/intents.near" target="_blank" rel="noreferrer" className="hd-arrowlink mt-6">
                intents.near on NearBlocks <ArrowUpRight />
              </a>
            </div>
            {trades.status === "loading" ? (
              <div className="grid gap-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="hd-skeleton h-14" />
                ))}
              </div>
            ) : trades.status === "error" ? (
              <Notice title="Could not read the record just now">
                The list of mainnet trades comes from the Hushd API, which is not answering right now.
              </Notice>
            ) : trades.record.steps.length === 0 ? (
              <p className="self-start rounded-[14px] bg-surface px-4 py-4 text-[14.5px] leading-relaxed text-soft sm:px-5">
                The mainnet demo trades between Hushd&apos;s agents are built and waiting for the owner&apos;s go-ahead.
              </p>
            ) : (
              <ul className="self-start divide-y divide-line border-y border-line">
                {trades.record.steps.map((st) => {
                  const base = trades.record.explorer?.startsWith("https://") ? trades.record.explorer.replace(/\/?$/, "/") : MAINNET_TX;
                  return (
                    <li key={st.step} className="grid gap-2 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-6">
                      <div className="min-w-0">
                        <p className="text-[14.5px] text-foreground">{stepWords(st.step)}</p>
                        {st.note && <p className="mt-0.5 text-[13px] leading-relaxed text-mute [overflow-wrap:anywhere]">{sentence(st.note)}.</p>}
                        <p className="tnum mt-1 text-[12.5px] text-faint">
                          {new Date(st.at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC
                        </p>
                      </div>
                      <div className="flex flex-wrap items-start gap-x-4 gap-y-1 sm:max-w-[260px] sm:justify-end">
                        {st.txs.map((h) => (
                          <a
                            key={h}
                            href={`${base}${encodeURIComponent(h)}`}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Transaction ${h} on NearBlocks`}
                            className="hd-tap tnum inline-flex items-center gap-1.5 text-[13.5px] text-foreground hover:underline"
                          >
                            {shortHash(h)} <ArrowUpRight className="text-faint" />
                          </a>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* what stays private */}
        <section id="private" aria-labelledby="private-title" className="mx-auto max-w-[1400px] scroll-mt-20 px-4 pt-20 sm:px-7 sm:pt-28">
          <div className="hd-panel bg-surface px-5 py-14 sm:px-12 sm:py-20">
            <SealedField tone="soft" />
            <div className="relative mx-auto grid max-w-[1120px] grid-cols-1 gap-12 lg:grid-cols-[1fr_2fr]">
              <div>
                <h2 id="private-title" className="t-display-l max-w-[10ch]">
                  What stays private
                </h2>
                <p className="mt-5 max-w-[36ch] text-[15px] leading-relaxed text-mute">
                  Deposits and cash outs are public by design, because tokens move between a NEAR account and the pool.
                  What happens inside the pool stays sealed.
                </p>
                <Link href="/docs/privacy-model" className="hd-arrowlink mt-8">
                  The full privacy model <span aria-hidden>→</span>
                </Link>
              </div>
              <div className="grid grid-cols-1 gap-10 sm:grid-cols-2">
                {PRIVATE_FACTS.map((f) => (
                  <div key={f.title} className="border-t border-foreground pt-5">
                    <p className="flex items-center gap-2.5 text-[18px] leading-snug tracking-[-0.01em]">
                      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-sealed-soft text-sealed">
                        <LockIcon size={10} />
                      </span>
                      {f.title}
                    </p>
                    <p className="mt-3 text-[14px] leading-relaxed text-mute">{f.body}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
