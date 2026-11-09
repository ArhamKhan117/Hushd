"use client";

import { ALREADY_CLAIMED, artifactsAt, checkLink, claimLink, isOwnLink, linkToken, NOT_IN_POOL, parseLink, takeBackLink, type Link as ClaimLink, type MerkleTree } from "@hushd/sdk";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppShell } from "@/components/app/AppShell";
import { ErrorLine, TxLine } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { BusyLabel, Spinner } from "@/components/ui/Spinner";
import { CIRCUITS_BASE, NETWORK } from "@/lib/hushd/config";
import { StateDot } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** What the pool says about the link, for one code and one attempt. */
type Pool = { state: "ready"; tree: MerkleTree } | { state: "claimed" | "missing" } | { state: "error"; message: string };

export default function ClaimPage() {
  const s = useHushd();
  // the link is after the #, which the browser never sends to any server
  const code = useSyncExternalStore(subscribeHash, () => location.hash.slice(1), () => null);
  const parsed = useMemo((): { link: ClaimLink } | { error: string } | null => {
    if (!code) return null;
    try {
      const link = parseLink(code);
      linkToken(NETWORK, link);
      return { link };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [code]);
  const link = parsed && "link" in parsed ? parsed.link : null;

  const [attempt, setAttempt] = useState(0);
  const key = `${code}:${attempt}`;
  const [checked, setChecked] = useState<{ key: string; pool: Pool } | null>(null);
  const pool = checked?.key === key ? checked.pool : null;
  useEffect(() => {
    if (!link) return;
    let live = true;
    checkLink(NETWORK, link).then(
      (r) => live && setChecked({ key, pool: r.state === "ready" ? { state: "ready", tree: r.tree } : { state: r.state } }),
      (e: Error) => live && setChecked({ key, pool: { state: "error", message: e.message } }),
    );
    return () => {
      live = false;
    };
  }, [link, key]);

  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ hash: string; own: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const own = Boolean(link && s.wallet && isOwnLink(s.wallet, link));

  const claim = async () => {
    if (!s.wallet || !link || pool?.state !== "ready") return;
    setBusy(true);
    setError(null);
    try {
      const opts = { artifacts: artifactsAt(CIRCUITS_BASE), relayer: s.relayer };
      const r = own ? await takeBackLink(s.wallet, link, opts) : await claimLink(link, { to: s.wallet, ...opts, tree: pool.tree });
      setDone({ hash: r.txHash, own });
      void s.sync();
    } catch (e) {
      const message = (e as Error).message;
      // someone else's claim landed first: the page now says so in place of the amount
      if (message === ALREADY_CLAIMED) setChecked({ key, pool: { state: "claimed" } });
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  const amount = link ? `${fmt(link.token, link.amount)} ${symbol(link.token)}` : "";

  return (
    <AppShell title="Claim a payment" subtitle="Someone paid you with a link. Claim it into your private balance: no gas and no seed phrase.">
      <div className="grid max-w-[560px] gap-4">
        {code === null ? (
          <Panel label="Claim link" title="Checking the link…" busy />
        ) : !parsed ? (
          <Panel label="Claim link" title="Open the link you were sent">
            A claim link ends in a code after the # sign. Open the whole link, as it was sent to you.
          </Panel>
        ) : "error" in parsed ? (
          <Panel label="Claim link" title="This link does not work">
            {parsed.error}
          </Panel>
        ) : done ? (
          <Panel label={done.own ? "Taken back" : "Claimed"} title={done.own ? `${amount} is back in your private balance` : `${amount} is now in your private balance`} amount>
            <TxLine hash={done.hash}>Sent privately by the relayer.</TxLine>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/app/balance" className="btn btn-ink">
                See your balance
              </Link>
              <Link href="/app" className="btn btn-quiet">
                Go to the desk
              </Link>
            </div>
          </Panel>
        ) : !pool ? (
          <Panel label="Claim link" title="Checking the payment in the pool…" busy />
        ) : pool.state === "error" ? (
          <Panel label="Claim link" title="Could not check this link">
            Could not reach NEAR to check the payment ({pool.message}).
            <div className="mt-4">
              <button type="button" className="btn btn-ghost" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          </Panel>
        ) : pool.state === "claimed" ? (
          <Panel label="Claim link" title={ALREADY_CLAIMED}>
            A link pays once. If you were expecting this payment, ask the sender.
          </Panel>
        ) : pool.state === "missing" ? (
          <Panel label="Claim link" title="Not in the pool yet">
            {NOT_IN_POOL}
            <div className="mt-4">
              <button type="button" className="btn btn-ghost" onClick={() => setAttempt((n) => n + 1)}>
                Check again
              </button>
            </div>
          </Panel>
        ) : (
          <>
            <div className="hd-card p-6 sm:p-8">
              <p className="t-label">You were paid</p>
              <p className="tnum mt-3 text-[40px] font-light leading-none tracking-[-0.02em] text-foreground sm:text-[48px]">
                {fmt(link!.token, link!.amount)} <span className="text-mute">{symbol(link!.token)}</span>
              </p>
              <p className="mt-4 flex items-center gap-2 text-[13px] text-mute">
                <StateDot tone="ok" />
                In the pool, and nobody has claimed it yet.
              </p>
            </div>
            {s.status !== "ready" ? (
              <SignInPanel title="Sign in to claim it" />
            ) : (
              <>
                {own && <p className="text-[13.5px] text-soft">You made this link. Claiming it here takes it back into your private balance.</p>}
                <button type="button" className="btn btn-ink btn-lg btn-block" disabled={busy} onClick={claim} aria-busy={busy}>
                  <BusyLabel busy={busy} busyText="Proving in your browser…">{own ? `Take back ${amount}` : `Claim ${amount}`}</BusyLabel>
                </button>
                <p className="text-[13px] leading-relaxed text-mute">
                  The payment moves into a new note only you can spend, made in this browser. The relayer sends it, so you pay no gas, and after this the
                  sender cannot take it back.
                </p>
              </>
            )}
            <ErrorLine error={error} />
          </>
        )}
      </div>
    </AppShell>
  );
}

function Panel({ label, title, children, busy, amount }: { label: string; title: string; children?: ReactNode; busy?: boolean; amount?: boolean }) {
  return (
    <div className="hd-card p-5 sm:p-6">
      <p className="t-label">{label}</p>
      <h2 className={`mt-2 flex items-center gap-3 text-foreground ${amount ? "t-title tnum" : "t-title"}`}>
        {busy && <Spinner className="h-4 w-4" />}
        {title}
      </h2>
      {children && <div className="mt-2 text-[14.5px] leading-relaxed text-mute [overflow-wrap:anywhere]">{children}</div>}
    </div>
  );
}
