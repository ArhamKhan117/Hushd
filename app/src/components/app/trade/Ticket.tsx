"use client";

/**
 * The trade ticket: buy or sell the pair's base, as spot or with a Hyperliquid hedge, for an
 * exact amount of what you give and a sealed least-you-accept. Asking runs the desk's flow
 * (`useDeskRun`); while it runs the ticket shows each step, then the receipt.
 */
import type { PackageKind, TokenInfo } from "@hushd/sdk";
import Link from "next/link";
import { Segmented, Steps } from "@/components/app/desk";
import { AmountCard, ErrorLine, Field, TxLine } from "@/components/app/forms";
import { SignInPanel } from "@/components/app/SignInPanel";
import { BusyLabel } from "@/components/ui/Spinner";
import { Spotlight } from "@/components/ui/Spotlight";
import { IS_TESTNET } from "@/lib/hushd/config";
import { fmt, symbol } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";
import type { Pair } from "./pairs";
import { runSteps, type Run } from "./useDeskRun";

export const KINDS = [
  { value: "spot", label: "Spot", hint: "Swap one token for another, settled privately in one call" },
  { value: "spot_hedge", label: "Spot + hedge", hint: "Experimental: the swap, plus a hedge order the maker places for its own account, with its bond at stake" },
  { value: "carry", label: "Cash and carry", hint: "Experimental: buy with a stablecoin, plus the same bonded hedge order, placed for the maker's own account" },
] as const satisfies readonly { value: PackageKind; label: string; hint: string }[];

export const WINDOWS = [
  { value: "20000", label: "20 s" },
  { value: "45000", label: "45 s" },
  { value: "90000", label: "90 s" },
] as const;
export type WindowMs = (typeof WINDOWS)[number]["value"];

export interface TicketState {
  side: "buy" | "sell";
  kind: PackageKind;
  amount: string;
  min: string;
  windowMs: WindowMs;
}

/** Under the package picker when a hedged package is picked: what it does and does not do for you. */
export function HedgedNote() {
  return (
    <>
      <span className="font-medium text-soft">Experimental.</span> You receive the spot leg. The maker commits, with its bond, to place a hedge
      order on Hyperliquid{IS_TESTNET ? " testnet" : ""} for its own account, so the position is the maker&apos;s, not yours. If the order misses, the bond is paid to you
      privately. Makers quote one only when they can place the hedge.{" "}
      <Link href="/docs/packages#spot-and-hedge" className="text-foreground underline decoration-line-strong underline-offset-4">
        How it works
      </Link>
    </>
  );
}

/** Why the package cannot be asked for, in words, or null. */
export function kindProblem(kind: PackageKind, sell: TokenInfo, buy: TokenInfo): string | null {
  if (kind === "spot") return null;
  if (!buy.hedgeCoin) return `${buy.symbol} has no Hyperliquid perp, so what you buy cannot be hedged. Pick Spot, or buy the other side.`;
  if (kind === "carry" && sell.hedgeCoin) return `Cash and carry buys with a stablecoin; this ticket pays in ${sell.symbol}. Pick Spot + hedge.`;
  return null;
}

/** A sensible way to write a limit: enough digits for this size, rounded down, no trailing zeros. */
export function limitText(t: TokenInfo, v: number): string {
  if (!(v > 0)) return "";
  const d = Math.min(t.decimals, Math.max(2, 6 - Math.floor(Math.log10(v))));
  const f = 10 ** d;
  return (Math.floor(v * f) / f).toFixed(d).replace(/\.?0+$/, "");
}

export function Ticket({
  pair,
  state,
  set,
  sell,
  buy,
  sellAmount,
  minAmount,
  estimate,
  run,
  busy,
  now,
  onAsk,
  onReset,
}: {
  pair: Pair;
  state: TicketState;
  set: (patch: Partial<TicketState>) => void;
  sell: TokenInfo;
  buy: TokenInfo;
  sellAmount: bigint | null;
  minAmount: bigint | null;
  /** About how much of `buy` the amount fetches at the mid, before any spread; null without a price. */
  estimate: number | null;
  run: Run | null;
  busy: boolean;
  now: number;
  onAsk: () => void;
  onReset: () => void;
}) {
  const s = useHushd();
  const have = s.balances.get(sell.id) ?? 0n;
  const problem = kindProblem(state.kind, sell, buy);
  const over = sellAmount !== null && sellAmount > have;
  const canAsk = s.status === "ready" && sellAmount !== null && !over && minAmount !== null && !problem && !busy;
  const t = run?.terms;
  const hedged = run ? run.draft.kind !== "spot" : state.kind !== "spot";

  if (s.status !== "ready") {
    // the app's own sign-in card, not a card inside the ticket's frame
    return (
      <section className="tt-ticket" aria-label="Ticket">
        <SignInPanel title="Open your private balance to trade" />
      </section>
    );
  }

  return (
    <section className="tt-panel tt-ticket hd-frame hd-sheen" aria-label="Ticket">
      {/* the pointer light sits inside the frame: both draw with ::before */}
      <Spotlight>
        <div className="tt-head">
          <h2 className="hd-index" data-n="02">
            <i aria-hidden />
            Ticket
          </h2>
          <span className="flex items-center gap-2 text-[12px] text-mute">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent" />
            Sealed request
          </span>
        </div>

        {run ? (
          <div className="grid gap-4 p-4">
            <Steps steps={runSteps(run, now)} />
            {run.phase === "settled" && t && run.dealId !== undefined && (
              <div className="grid gap-3 border-t border-line pt-4">
                <p className="t-label">Receipt</p>
                <p className="text-[14.5px] text-foreground">
                  You gave {fmt(t.traderGives.token, BigInt(t.traderGives.amount))} {symbol(t.traderGives.token)} and received {fmt(t.makerGives.token, BigInt(t.makerGives.amount))} {symbol(t.makerGives.token)}, privately.
                </p>
                <p className="text-[13px] leading-relaxed text-mute">
                  {hedged
                    ? `You hold what you bought. ${run.makerName} now places its hedge order on Hyperliquid${IS_TESTNET ? " testnet" : ""} for its own account, signed by the desk's Chain Signatures from this deal's address. If the order misses its deadline, the maker's bond is paid to you as a private note.`
                    : `The chain shows that deal #${run.dealId} settled, not who traded or how much.`}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link href={`/app/deals/${run.dealId}`} className="btn btn-ghost btn-sm">
                    Open deal #{run.dealId}
                  </Link>
                  <Link href={`/app/prove?deal=${run.dealId}`} className="btn btn-ghost btn-sm">
                    Prove this payment
                  </Link>
                </div>
              </div>
            )}
            {run.matchTx && <TxLine hash={run.matchTx}>The enclave&apos;s match is on chain.</TxLine>}
            <ErrorLine error={run.error ?? null} />
            {(run.phase === "settled" || run.failed) && (
              <button type="button" className="btn btn-ink btn-lg btn-block" onClick={onReset}>
                New request
              </button>
            )}
          </div>
        ) : (
          <form
            className="grid gap-4 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canAsk) onAsk();
            }}
          >
            <div className="tt-side" role="group" aria-label="Side">
              <button type="button" aria-pressed={state.side === "buy"} onClick={() => set({ side: "buy", min: "" })}>
                Buy {pair.base.symbol}
              </button>
              <button type="button" aria-pressed={state.side === "sell"} onClick={() => set({ side: "sell", min: "" })}>
                Sell {pair.base.symbol}
              </button>
            </div>

            <Field label="Package" hint={state.kind === "spot" ? undefined : <HedgedNote />}>
              <Segmented label="Package" value={state.kind} onChange={(kind) => set({ kind })} options={KINDS} />
            </Field>

            <AmountCard
              label={state.side === "buy" ? "You pay" : "You sell"}
              value={state.amount}
              onChange={(amount) => set({ amount })}
              picker={<span className="tt-tokenbadge">{sell.symbol}</span>}
              note={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="tnum">
                    Private balance: {fmt(sell.id, have)} {sell.symbol}
                  </span>
                  {have > 0n ? (
                    <button type="button" className="hd-tap text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground" onClick={() => set({ amount: fmt(sell.id, have, sell.decimals).replace(/,/g, "") })}>
                      Max
                    </button>
                  ) : (
                    <Link href="/app/balance/add" className="hd-tap text-foreground underline decoration-line-strong underline-offset-4">
                      Add some
                    </Link>
                  )}
                </span>
              }
            />
            <p className="-mt-2 px-1 text-[12.5px] text-mute" aria-live="polite">
              {estimate !== null && sellAmount !== null ? (
                <>
                  About <span className="tnum text-soft">{limitText(buy, estimate)}</span> {buy.symbol} at the mid, before the maker&apos;s spread.
                </>
              ) : (
                <>You get {buy.symbol}. Makers see the pair, the side and this size, never your limit.</>
              )}
            </p>

            <Field label={`Least you accept, in ${buy.symbol}`} hint="Sealed: only the enclave reads it. Leave it empty to take the best quote, never less than 3% under the market price.">
              <input
                id="tt-min"
                className="hd-input tnum w-full"
                inputMode="decimal"
                autoComplete="off"
                placeholder="Best quote"
                aria-label={`Least you accept, in ${buy.symbol}`}
                value={state.min}
                onChange={(e) => set({ min: e.target.value.replace(/[^\d.,]/g, "") })}
              />
              {estimate !== null && sellAmount !== null && (
                <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Limit from the mid">
                  {[0.005, 0.01, 0.02].map((k) => (
                    <button key={k} type="button" className="hd-chip tnum" onClick={() => set({ min: limitText(buy, estimate * (1 - k)) })}>
                      Mid − {k * 100}%
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <Field label="Quote window">
              <Segmented label="Quote window" value={state.windowMs} onChange={(windowMs) => set({ windowMs })} options={WINDOWS} />
            </Field>

            {problem && <p className="text-[13px] leading-relaxed text-warn">{problem}</p>}
            <button type="submit" className="btn btn-ink btn-lg btn-block" disabled={!canAsk} aria-busy={busy}>
              <BusyLabel busy={busy} busyText="Sealing…">
                {over ? "More than your private balance" : state.side === "buy" ? `Ask to buy ${pair.base.symbol}` : `Ask to sell ${pair.base.symbol}`}
              </BusyLabel>
            </button>
          </form>
        )}
      </Spotlight>
    </section>
  );
}
