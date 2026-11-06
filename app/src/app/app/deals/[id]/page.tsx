"use client";

import { accountUrl, closeHedgeSignature, deskView, toB64, txUrl, type DealView } from "@hushd/sdk";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { ErrorLine, TxLine } from "@/components/app/forms";
import { BusyLabel } from "@/components/ui/Spinner";
import { NETWORK } from "@/lib/hushd/config";
import { CLASS_WORDS, dealState, KIND_WORDS, StateDot, when } from "@/lib/hushd/deal";
import { fmt, symbol } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

interface DealEvent {
  event: string;
  data: Record<string, unknown>;
  tx_hash: string;
  block_height: string;
  block_ms: string;
}

const EVENT_WORDS: Record<string, string> = {
  deal_matched: "Matched by the enclave",
  spot_settled: "Spot leg settled in the pool",
  settle_failed: "A settlement attempt failed (nothing moved)",
  hedge_signed: "Hedge order signed by Chain Signatures",
  hedge_sign_failed: "Hedge signing failed",
  bond_slashed: "Maker's bond paid to the trader",
  receipt: "Receipt recorded",
};

const EVIDENCE_WORDS: Record<string, string> = {
  pool_settlement: "Pool settlement (leaf)",
  pool_root: "Pool root after settlement",
  hyperliquid_fill: "Hyperliquid fill",
  hyperliquid_reject: "Hyperliquid did not fill",
  hedge_overdue: "Hedge overdue",
  bond_paid_privately: "Bond paid as a private note",
  bond_payout_returned: "Bond payout returned",
  intents_tx: "NEAR Intents settlement",
  expired: "Expired",
};

/** How the match reached the desk (the deal's `attested_by`), in words. */
const ATTESTED_WORDS: Record<string, string> = {
  enclave_signature: "signed with the matcher enclave's key",
  outlayer: "returned by OutLayer's on-chain callback",
};

const BOND = NETWORK.bondToken ?? NETWORK.tokens[0]!.id;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-[13px] text-mute">{label}</dt>
      <dd className="min-w-0 break-words text-[14px] text-foreground">{children}</dd>
    </div>
  );
}

/** The desk's record of a deal, its indexed events and its maker's name. */
async function fetchDeal(dealId: number) {
  const [deal, makers, ev] = await Promise.all([
    deskView.deal(NETWORK, dealId),
    deskView.makers(NETWORK),
    fetch(`${NETWORK.api}/v1/deals/${dealId}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ events: DealEvent[] }>) : { events: [] }))
      .catch(() => ({ events: [] as DealEvent[] })),
  ]);
  return { deal, events: ev.events, makerName: deal ? (makers.find(([acc]) => acc === deal.maker)?.[1].name ?? null) : null };
}

export default function DealPage() {
  const { id } = useParams<{ id: string }>();
  const dealId = Number(id);
  const s = useHushd();
  const [deal, setDeal] = useState<DealView | null | undefined>(undefined);
  const [events, setEvents] = useState<DealEvent[]>([]);
  const [makerName, setMakerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);

  const load = useCallback(
    () =>
      fetchDeal(dealId).then(
        (r) => {
          setDeal(r.deal);
          setEvents(r.events);
          setMakerName(r.makerName);
        },
        (e: Error) => setError(e.message),
      ),
    [dealId],
  );

  const validId = Number.isInteger(dealId) && dealId >= 0;
  useEffect(() => {
    if (!validId) return;
    let live = true;
    const tick = () =>
      fetchDeal(dealId).then(
        (r) => {
          if (!live) return;
          setDeal(r.deal);
          setEvents(r.events);
          setMakerName(r.makerName);
        },
        (e: Error) => live && setError(e.message),
      );
    void tick();
    const t = setInterval(tick, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [validId, dealId]);

  const mine = s.wallet?.deals().find((d) => d.dealId === dealId);
  const canClose = Boolean(mine?.refundBlinding && deal?.hedge && deal.status === "closed" && deal.hedge_orders === 1 && deal.receipt?.outcome === "settled");

  const closeHedge = async () => {
    if (!s.identity || !mine?.refundBlinding) return;
    setClosing(true);
    setError(null);
    try {
      const sig = closeHedgeSignature(s.identity, BigInt(mine.refundBlinding), dealId);
      const r = await s.relayer.closeHedge(dealId, toB64(sig));
      setClosed(r.txHash);
      void load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClosing(false);
    }
  };

  const st = deal ? dealState(deal) : null;
  return (
    <AppShell title={`Deal #${Number.isFinite(dealId) ? dealId : "?"}`} subtitle="The desk's public record of this deal, and what only you can see of it.">
      <div className="grid max-w-[760px] gap-5">
        <Link href="/app/deals" className="text-[13px] text-mute hover:text-foreground">
          ← All deals
        </Link>
        {validId && deal === undefined && !error && <div className="hd-skeleton h-48" />}
        {(!validId || deal === null) && <p className="text-[14px] text-mute">The desk has no deal #{id}.</p>}
        {deal && st && (
          <>
            {mine && (
              <div className="hd-card grid gap-2 p-5 sm:p-6">
                <p className="t-label">Your side (private)</p>
                <p className="text-[15px] text-foreground">
                  {KIND_WORDS[mine.kind]}: you gave {fmt(mine.gave.token, BigInt(mine.gave.amount))} {symbol(mine.gave.token)} for {fmt(mine.got.token, BigInt(mine.got.amount))} {symbol(mine.got.token)}.
                </p>
                {BigInt(mine.bond) > 0n && <p className="text-[13px] text-mute">The maker bonded {fmt(BOND, BigInt(mine.bond))} {symbol(BOND)} on this deal. If it misses the hedge, the bond is paid to you as a private note.</p>}
                <div className="mt-1 flex flex-wrap gap-2">
                  <Link href={`/app/prove?deal=${dealId}`} className="btn btn-ghost btn-sm">
                    Prove this payment
                  </Link>
                  {canClose && (
                    <button type="button" className="btn btn-ink btn-sm" onClick={closeHedge} disabled={closing} aria-busy={closing}>
                      <BusyLabel busy={closing} busyText="Signing the close…">
                        Close the hedge
                      </BusyLabel>
                    </button>
                  )}
                </div>
                {closed && <TxLine hash={closed}>The close order was signed by Chain Signatures.</TxLine>}
              </div>
            )}

            <div className="hd-card px-5 sm:px-6">
              <dl className="divide-y divide-line">
                <Row label="State">
                  <span className="flex items-center gap-2">
                    <StateDot tone={st.tone} />
                    {st.word}
                  </span>
                </Row>
                <Row label="Settlement">{CLASS_WORDS[deal.class]}</Row>
                <Row label="Maker">
                  <a href={accountUrl(NETWORK, deal.maker)} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-foreground">
                    {makerName ? `${makerName} (${deal.maker})` : deal.maker}
                  </a>
                </Row>
                <Row label="Matched">
                  {when(deal.matched_at_ms)}, {ATTESTED_WORDS[deal.attested_by] ?? <>attested by <span className="break-all text-soft">{deal.attested_by}</span></>}
                </Row>
                <Row label="Terms hash">
                  <span className="break-all font-mono text-[12.5px] text-soft">{deal.terms_hash}</span>
                </Row>
                {BigInt(deal.bond) > 0n && <Row label="Maker's bond">{fmt(BOND, BigInt(deal.bond))} {symbol(BOND)}</Row>}
                {deal.hedge && (
                  <Row label="Hedge">
                    {deal.hedge.is_buy ? "Buy" : "Sell"} {deal.hedge.size} {deal.hedge.coin} perp on Hyperliquid{deal.hedge.testnet ? " testnet" : ""}, limit {deal.hedge.limit_px}, by {when(deal.hedge.deadline_ms)}.
                    <span className="block text-[12.5px] text-mute">Signed by NEAR Chain Signatures from the path hushd/hedge/{deal.id}; only the deal&apos;s owner key can close it.</span>
                  </Row>
                )}
                {deal.receipt && (
                  <Row label="Receipt">
                    <span className="block capitalize">{deal.receipt.outcome}, {when(deal.receipt.recorded_at_ms)}</span>
                    <ul className="mt-1.5 grid gap-1">
                      {deal.receipt.evidence.map((e, i) => (
                        <li key={i} className="text-[12.5px] text-mute">
                          <span className="text-soft">{EVIDENCE_WORDS[e.kind] ?? e.kind}:</span> <span className="break-all">{e.reference}</span>
                        </li>
                      ))}
                    </ul>
                  </Row>
                )}
              </dl>
            </div>

            {events.length > 0 && (
              <section className="grid gap-3">
                <p className="t-label">On chain</p>
                <ol className="hd-card divide-y divide-line">
                  {events.map((e, i) => (
                    <li key={`${e.tx_hash}-${i}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
                      <span className="text-[13.5px] text-foreground">{EVENT_WORDS[e.event] ?? e.event}</span>
                      <a href={txUrl(NETWORK, e.tx_hash)} target="_blank" rel="noreferrer" className="text-[12.5px] text-mute underline decoration-line-strong underline-offset-4 hover:text-foreground">
                        {when(e.block_ms)} · NearBlocks
                      </a>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
        <ErrorLine error={error} />
      </div>
    </AppShell>
  );
}
