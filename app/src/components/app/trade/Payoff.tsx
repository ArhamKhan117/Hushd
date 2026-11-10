"use client";

/**
 * What the package is worth to you against the price of the asset it buys, from the terms on
 * the ticket (at today's mid) or the terms the enclave matched. You hold the spot leg, which
 * moves with the price. A hedged package's hedge order trades for the maker's own Hyperliquid
 * account, so it is not drawn as yours; what it adds for you is the maker's bond, paid to you
 * if the order misses, drawn as the spot leg plus the bond. Fees and gas are left out, and the
 * chart says so.
 */
import { tokenInfo, type AgreedTerms, type PackageKind, type TokenInfo } from "@hushd/sdk";
import { useMemo, useRef, useState, type PointerEvent } from "react";
import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";
import { fmtPrice, fmtUsd, whole } from "./pairs";

export interface PayoffModel {
  asset: TokenInfo;
  /** Units bought. */
  qty: number;
  /** USD paid per unit. */
  basis: number;
  /** The maker's hedge order (for its own account): its size in units and its limit in USD. */
  hedge: { size: number; entry: number } | null;
  /** The maker's bond, paid to you if the hedge misses (USD). */
  bondUsd: number | null;
  /** The asset's USD mid now. */
  mid: number;
  /** What was given is not a dollar: its cost is valued at today's mid. */
  basisAtMid: boolean;
  from: "ticket" | "terms";
  dealId?: number;
}

/** The ticket, priced at today's mids: what you would buy, at the mid, before any spread. */
export function ticketModel(o: { kind: PackageKind; sell: TokenInfo; buy: TokenInfo; sellAmount: bigint | null; sellUsd: number | null; buyUsd: number | null }): PayoffModel | null {
  if (!o.sellAmount || !o.sellUsd || !o.buyUsd || !o.buy.hedgeCoin) return null;
  const qty = (whole(o.sell, o.sellAmount) * o.sellUsd) / o.buyUsd;
  return { asset: o.buy, qty, basis: o.buyUsd, hedge: o.kind === "spot" ? null : { size: qty, entry: o.buyUsd }, bondUsd: null, mid: o.buyUsd, basisAtMid: true, from: "ticket" };
}

/** The matched terms: the amounts agreed, the hedge order's size and limit, and the bond. */
export function termsModel(t: AgreedTerms, dealId: number | undefined, usd: (token: TokenInfo) => number | null): PayoffModel | null {
  const sell = tokenInfo(NETWORK, t.traderGives.token);
  const buy = tokenInfo(NETWORK, t.makerGives.token);
  const sellUsd = usd(sell);
  const mid = usd(buy);
  if (!buy.hedgeCoin || !sellUsd || !mid) return null;
  const qty = whole(buy, t.makerGives.amount);
  const paid = whole(sell, t.traderGives.amount) * sellUsd;
  const bondToken = NETWORK.bondToken ? tokenInfo(NETWORK, NETWORK.bondToken) : null;
  return {
    asset: buy,
    qty,
    basis: paid / qty,
    hedge: t.hedge ? { size: (t.hedge.is_buy ? -1 : 1) * Number(t.hedge.size), entry: Number(t.hedge.limit_px) } : null,
    bondUsd: bondToken && BigInt(t.bond) > 0n ? whole(bondToken, t.bond) * (usd(bondToken) ?? 1) : null,
    mid,
    basisAtMid: Boolean(sell.hedgeCoin),
    from: "terms",
    dealId,
  };
}

const W = 320;
const H = 176;
const PAD = { l: 8, r: 58, t: 12, b: 26 };

/** "+$15", "−$1,000": the value of a line where it ends. */
const signed = (v: number) => `${v > 0.005 ? "+" : ""}${fmtUsd(v)}`;

/** Labels at the right end of the lines, nudged apart so none covers another. */
function endLabels(items: { key: string; y: number; text: string; cls: string }[], top: number, bottom: number) {
  const out = [...items].sort((a, b) => a.y - b.y);
  for (let i = 1; i < out.length; i++) if (out[i]!.y - out[i - 1]!.y < 13) out[i] = { ...out[i]!, y: out[i - 1]!.y + 13 };
  const over = (out.at(-1)?.y ?? 0) - bottom;
  return out.map((l) => ({ ...l, y: Math.max(top, over > 0 ? l.y - over : l.y) }));
}

/** What you hold: the spot leg, and on a hedged deal with a bond, the spot leg plus the bond if the hedge misses. */
function lines(m: PayoffModel) {
  const spot = (p: number) => m.qty * (p - m.basis);
  return { spot, miss: (p: number) => spot(p) + (m.bondUsd ?? 0) };
}

export function Payoff({ model, kind, buy, minBondUsd }: { model: PayoffModel | null; kind: PackageKind; buy: TokenInfo; minBondUsd: number | null }) {
  const svg = useRef<SVGSVGElement>(null);
  const [at, setAt] = useState<number | null>(null);
  const venue = `Hyperliquid${IS_TESTNET ? " testnet" : ""}`;

  const g = useMemo(() => {
    if (!model) return null;
    const f = lines(model);
    const lo = model.mid * 0.9;
    const hi = model.mid * 1.1;
    const samples = [lo, model.mid, hi, model.basis].filter((p) => p >= lo && p <= hi);
    const ys = samples.flatMap((p) => [f.spot(p), ...(model.hedge && model.bondUsd ? [f.miss(p)] : [])]);
    let yLo = Math.min(0, ...ys);
    let yHi = Math.max(0, ...ys);
    const pad = (yHi - yLo) * 0.1 || Math.max(1, model.qty * model.mid * 0.01);
    yLo -= pad;
    yHi += pad;
    const x = (p: number) => PAD.l + ((p - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
    const y = (v: number) => PAD.t + ((yHi - v) / (yHi - yLo)) * (H - PAD.t - PAD.b);
    const path = (fn: (p: number) => number) => `M${x(lo).toFixed(1)},${y(fn(lo)).toFixed(1)}L${x(hi).toFixed(1)},${y(fn(hi)).toFixed(1)}`;
    return { f, lo, hi, x, y, path };
  }, [model]);

  const move = (e: PointerEvent<SVGSVGElement>) => {
    if (!g || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const p = g.lo + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (g.hi - g.lo);
    setAt(Math.max(g.lo, Math.min(g.hi, p)));
  };

  const price = at ?? model?.mid ?? null;
  const hedged = kind !== "spot";
  // the bond line shows only on a hedged deal whose bond is known
  const missLine = Boolean(model?.hedge) && model?.bondUsd != null;

  return (
    <section className="tt-panel tt-payoff hd-frame" aria-label="Payoff">
      <div className="tt-head">
        <h2 className="hd-index" data-n="03">
          <i aria-hidden />
          Payoff
        </h2>
        <span className="truncate text-[12px] text-mute">{model?.from === "terms" ? `Deal #${model.dealId ?? ""} as agreed` : "From your ticket, at the mid"}</span>
      </div>
      <div className="grid gap-3 p-4">
        {!buy.hedgeCoin ? (
          <p className="text-[13px] leading-relaxed text-mute">You end up holding {buy.symbol}, which does not move with the market, so there is nothing to draw. Buy wNEAR or BTC to see a payoff.</p>
        ) : !model || !g ? (
          <p className="text-[13px] leading-relaxed text-mute">Enter an amount on the ticket to see what the package is worth as the {buy.symbol} price moves.</p>
        ) : (
          <>
            <svg
              ref={svg}
              viewBox={`0 0 ${W} ${H}`}
              className="tt-payoff-svg block h-auto w-full touch-pan-y"
              role="img"
              aria-label={`Value of the package against the ${model.asset.symbol} price, from ${fmtPrice(g.lo)} to ${fmtPrice(g.hi)} USD`}
              onPointerMove={move}
              onPointerDown={move}
              onPointerLeave={() => setAt(null)}
            >
              {[0.25, 0.5, 0.75].map((k) => (
                <line key={k} className="tt-gridline" x1={g.x(g.lo + (g.hi - g.lo) * k)} x2={g.x(g.lo + (g.hi - g.lo) * k)} y1={PAD.t} y2={H - PAD.b} />
              ))}
              <line className="tt-zero" x1={PAD.l} x2={W - PAD.r} y1={Math.round(g.y(0)) + 0.5} y2={Math.round(g.y(0)) + 0.5} />
              {missLine && <path className="tt-miss" d={g.path(g.f.miss)} />}
              {/* the spot leg is what you hold: drawn as the package */}
              <path className="tt-pkg" d={g.path(g.f.spot)} />
              {price !== null && <line className="tt-nowmark" x1={Math.round(g.x(price)) + 0.5} x2={Math.round(g.x(price)) + 0.5} y1={PAD.t} y2={H - PAD.b} />}
              {endLabels(
                [
                  { key: "spot", y: g.y(g.f.spot(g.hi)), text: signed(g.f.spot(g.hi)), cls: "tt-endpkg" },
                  ...(missLine ? [{ key: "miss", y: g.y(g.f.miss(g.hi)), text: signed(g.f.miss(g.hi)), cls: "" }] : []),
                ],
                PAD.t + 4,
                H - PAD.b - 4,
              ).map((l) => (
                <text key={l.key} x={W - PAD.r + 6} y={l.y} dy="0.34em" className={l.cls}>
                  {l.text}
                </text>
              ))}
              {price !== null && (
                <circle cx={g.x(price)} cy={g.y(g.f.spot(price))} r={3} className="fill-[var(--foreground)]" />
              )}
              <text x={PAD.l} y={H - 8}>
                {fmtPrice(g.lo)}
              </text>
              <text x={W / 2} y={H - 8} textAnchor="middle">
                {fmtPrice(model.mid)} now
              </text>
              <text x={W - PAD.r} y={H - 8} textAnchor="middle">
                {fmtPrice(g.hi)}
              </text>
            </svg>
            {price !== null && (
              <dl className={`grid gap-2 text-[12px] ${missLine ? "grid-cols-3" : "grid-cols-2"}`}>
                <div className="min-w-0">
                  <dt className="text-mute">{model.asset.symbol} at</dt>
                  <dd className="tnum truncate text-foreground">{fmtPrice(price)}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-mute">{model.hedge ? "Your spot leg" : "Package"}</dt>
                  <dd className="tnum truncate font-medium text-foreground">{fmtUsd(g.f.spot(price))}</dd>
                </div>
                {missLine && (
                  <div className="min-w-0">
                    <dt className="text-mute">Hedge missed</dt>
                    <dd className="tnum truncate text-foreground">{fmtUsd(g.f.miss(price))}</dd>
                  </div>
                )}
              </dl>
            )}
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-soft">
              <li className="flex items-center gap-2">
                <span className="tt-key" aria-hidden /> {model.hedge ? "Your spot leg" : "Package, spot only"}
              </li>
              {missLine && (
                <li className="flex items-center gap-2">
                  <span className="tt-key" data-k="miss" aria-hidden /> Hedge missed: spot plus the bond
                </li>
              )}
            </ul>
            <p className="text-[12px] leading-relaxed text-mute">
              {model.from === "terms"
                ? `${fmtNum(model.qty)} ${model.asset.symbol} bought at ${model.basisAtMid ? "about " : ""}${fmtPrice(model.basis)} USD each${model.basisAtMid ? " (what you gave, at today's mid)" : ""}.`
                : "At the mid, before the maker's spread."}{" "}
              {hedged
                ? `Experimental: the maker's ${venue} hedge order${model.hedge && model.from === "terms" ? ` (${model.hedge.size < 0 ? "buy" : "sell"} ${fmtNum(Math.abs(model.hedge.size))} at ${fmtPrice(model.hedge.entry)} or better)` : ""} trades for its own account, so it is not part of your payoff. ${
                    model.bondUsd !== null
                      ? `If it does not fill in time, the maker's ${fmtUsd(model.bondUsd)} bond is paid to you privately.`
                      : `A hedged quote bonds${minBondUsd !== null ? ` at least ${fmtUsd(minBondUsd)}` : ""}, paid to you if the order misses.`
                  }`
                : "Spot has no hedge leg: it moves one for one with the price."}{" "}
              Fees and gas left out.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function fmtNum(v: number): string {
  const d = Math.max(0, Math.min(8, 4 - Math.floor(Math.log10(Math.abs(v) || 1))));
  return v.toLocaleString("en-US", { maximumFractionDigits: d });
}
