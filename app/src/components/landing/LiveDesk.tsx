"use client";

import { deskView, poolView, type DealView, type PoolStats } from "@hushd/sdk";
import { useCallback, useEffect, useState } from "react";
import { NETWORK } from "@/lib/hushd/config";
import { CLASS_WORDS, dealState, StateDot, when } from "@/lib/hushd/deal";

/**
 * The desk as the chain sees it, read in the browser from the pool and desk
 * contracts on NEAR testnet. Nothing here is cached, estimated or made up: when
 * the contracts cannot be read, it says so and shows no number.
 */

type DeskStats = { rfqs: number; deals: number; settled: number; recovered: number; failed: number; unresolved: number };

type State =
  | { status: "loading" }
  | { status: "ready"; pool: PoolStats; desk: DeskStats; deals: DealView[]; at: number }
  | { status: "missing"; account: string }
  | { status: "error" };

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : 0);
const intFmt = new Intl.NumberFormat("en-US");

function readDesk(raw: Record<string, unknown>): DeskStats {
  return {
    rfqs: num(raw.rfqs),
    deals: num(raw.deals),
    settled: num(raw.settled),
    recovered: num(raw.recovered),
    failed: num(raw.failed),
    unresolved: num(raw.unresolved),
  };
}

function useDesk() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([poolView.stats(NETWORK), deskView.stats(NETWORK), deskView.deals(NETWORK, 4)])
      .then(([pool, desk, deals]) => {
        if (live) setState({ status: "ready", pool, desk: readDesk(desk ?? {}), deals, at: Date.now() });
      })
      .catch((e: Error) => {
        if (!live) return;
        const m = /^(\S+) does not exist/.exec(e.message ?? "");
        if (/UNKNOWN_ACCOUNT/.test(e.message ?? "")) setState({ status: "missing", account: m?.[1] ?? NETWORK.pool ?? "The pool" });
        else setState({ status: "error" });
      });
    return () => {
      live = false;
    };
  }, [nonce]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setNonce((n) => n + 1);
  }, []);
  return { state, retry };
}

function Tile({ label, value, sealed = false }: { label: string; value: number; sealed?: boolean }) {
  return (
    <div className="flex min-h-[96px] flex-col justify-between rounded-[14px] bg-surface p-4">
      <span className="flex items-center justify-between gap-2 text-[12.5px] text-mute">
        {label}
        {sealed && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-sealed" />}
      </span>
      <span className="tnum mt-3 text-[28px] font-light leading-none tracking-[-0.02em] text-foreground">{intFmt.format(value)}</span>
    </div>
  );
}

export function LiveDesk() {
  const { state, retry } = useDesk();

  return (
    <div className="hd-glass p-2">
      <div className="rounded-[12px] bg-panel p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="inline-flex items-center gap-2 text-[13px] text-mute">
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${state.status === "ready" ? "livedot bg-sealed" : "bg-line-strong"}`} />
            Read from NEAR {NETWORK.id} in your browser
          </p>
          {state.status === "ready" && (
            <p className="tnum text-[12.5px] text-faint">
              {new Date(state.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </p>
          )}
        </div>

        <div aria-live="polite" className="mt-4">
          {state.status === "loading" && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="hd-skeleton h-[96px] rounded-[14px]" />
              ))}
            </div>
          )}

          {state.status === "missing" && (
            <div className="rounded-[14px] bg-surface px-4 py-5 sm:px-5">
              <p className="text-[15px] text-foreground">Nothing to count yet</p>
              <p className="mt-1.5 max-w-[60ch] text-[13.5px] leading-relaxed text-mute">
                {state.account} is not on NEAR {NETWORK.id} yet. Once the contracts are deployed, the number of deposits,
                private transfers, cash outs and desk deals shows here, read straight from the chain.
              </p>
            </div>
          )}

          {state.status === "error" && (
            <div className="flex flex-col items-start gap-3 rounded-[14px] bg-surface px-4 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div>
                <p className="text-[15px] text-foreground">Could not read the chain just now</p>
                <p className="mt-1.5 max-w-[56ch] text-[13.5px] leading-relaxed text-mute">
                  Public NEAR RPC nodes sometimes slow down or limit requests. No number is shown rather than an old one.
                </p>
              </div>
              <button type="button" onClick={retry} className="btn btn-ghost btn-sm shrink-0">
                Try again
              </button>
            </div>
          )}

          {state.status === "ready" && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile label="Deposits" value={state.pool.shields} />
                <Tile label="Private transfers" value={state.pool.transfers} sealed />
                <Tile label="Desk deals" value={state.desk.deals} />
                <Tile label="Settled privately" value={state.pool.swaps} sealed />
              </div>
              {state.deals.length > 0 ? (
                <ul className="mt-3 divide-y divide-line rounded-[14px] border border-line px-4">
                  {state.deals.map((d) => {
                    const s = dealState(d);
                    return (
                      <li key={d.id} className="flex min-h-[52px] flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 text-[13.5px]">
                        <span className="text-foreground">
                          Deal #{d.id}
                          <span className="ml-2 text-mute">{CLASS_WORDS[d.class]}</span>
                        </span>
                        <span className="inline-flex items-center gap-2 text-soft">
                          <StateDot tone={s.tone} />
                          {s.word}
                          <span className="tnum text-faint">{when(d.matched_at_ms)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="mt-3 rounded-[14px] bg-surface px-4 py-3 text-[13.5px] text-mute">No desk deals yet.</p>
              )}
              <p className="mt-3 text-[12.5px] leading-relaxed text-mute">
                Counts and deal outcomes are public. Who traded, and how much, is not.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
