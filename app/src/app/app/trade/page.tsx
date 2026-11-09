"use client";

/**
 * Trade: the desk as a trading screen. Live Hyperliquid prices for the pairs the desk
 * trades, the makers and what the chain shows of the desk, a ticket that asks for a sealed
 * quote with the same flow as the Desk page, the payoff of the package, and your requests,
 * deals, hedge legs and receipts below. Prices come through the Hushd API; nothing on this
 * screen is made up.
 */
import type { CandleInterval } from "@hushd/sdk";
import { tokenInfo } from "@hushd/sdk";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app/AppShell";
import { ChartPanel } from "@/components/app/trade/ChartPanel";
import { InstrumentBar } from "@/components/app/trade/InstrumentBar";
import { Makers } from "@/components/app/trade/Makers";
import { pairById, pairMid, PAIRS, usdOf, whole } from "@/components/app/trade/pairs";
import { Payoff, termsModel, ticketModel } from "@/components/app/trade/Payoff";
import { StatusBar } from "@/components/app/trade/StatusBar";
import { Ticket, type TicketState } from "@/components/app/trade/Ticket";
import { useDeskRun } from "@/components/app/trade/useDeskRun";
import { useDealViews, useDeskPublic, useHour, useMids, useNetwork, useNow, useSeries } from "@/components/app/trade/useMarket";
import { Workspace } from "@/components/app/trade/Workspace";
import { NETWORK } from "@/lib/hushd/config";
import { parseAmount } from "@/lib/hushd/format";
import { useHushd } from "@/lib/hushd/session";

const PREFS = "hushd.trade.prefs";
const INTERVAL_IDS: CandleInterval[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

interface Prefs {
  pair: string;
  interval: CandleInterval;
  mode: "candles" | "line";
}

/** The market, candle size and chart type this viewer chose last, kept in this browser only. */
function usePrefs(): [Prefs, (p: Partial<Prefs>) => void] {
  const [prefs, setPrefs] = useState<Prefs>({ pair: PAIRS[0]!.id, interval: "5m", mode: "candles" });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS) ?? "null") as Partial<Prefs> | null;
      if (!saved) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount: the server render has no storage
      setPrefs((p) => ({
        pair: PAIRS.some((x) => x.id === saved.pair) ? saved.pair! : p.pair,
        interval: INTERVAL_IDS.includes(saved.interval as CandleInterval) ? saved.interval! : p.interval,
        mode: saved.mode === "line" ? "line" : "candles",
      }));
    } catch {
      /* no storage here: the defaults stand */
    }
  }, []);
  const update = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS, JSON.stringify(next));
      } catch {
        /* not kept, which is fine */
      }
      return next;
    });
  return [prefs, update];
}

export default function TradePage() {
  const s = useHushd();
  const [prefs, setPref] = usePrefs();
  const pair = pairById(prefs.pair);
  const mids = useMids();
  const series = useSeries(pair, prefs.interval);
  const hour = useHour(pair);
  const desk = useDeskPublic();
  const net = useNetwork();
  const clock = useNow(10_000);
  const { run, runs, busy, now, ask, reset } = useDeskRun();
  const [ticket, setTicketState] = useState<TicketState>({ side: "buy", kind: "spot", amount: "", min: "", windowMs: "45000" });
  const setTicket = (patch: Partial<TicketState>) => setTicketState((t) => ({ ...t, ...patch, ...(patch.side && patch.side !== t.side ? { amount: "", min: "" } : {}) }));

  const m = mids.data?.mids ?? null;
  const mid = pairMid(pair, m);
  const sell = ticket.side === "buy" ? pair.quote : pair.base;
  const buy = ticket.side === "buy" ? pair.base : pair.quote;
  const sellAmount = parseAmount(sell.id, ticket.amount);
  const minAmount = ticket.min.trim() === "" ? 0n : parseAmount(buy.id, ticket.min);
  const sellUsd = usdOf(sell, m);
  const buyUsd = usdOf(buy, m);
  const estimate = sellAmount !== null && sellUsd !== null && buyUsd !== null ? (whole(sell, sellAmount) * sellUsd) / buyUsd : null;

  const mine = s.wallet?.deals() ?? [];
  const views = useDealViews(mine.slice(0, 25).map((d) => d.dealId));

  const usd = (t: Parameters<typeof usdOf>[0]) => usdOf(t, m);
  const model = run?.terms ? termsModel(run.terms, run.dealId, usd) : ticketModel({ kind: ticket.kind, sell, buy, sellAmount, sellUsd, buyUsd });
  const payoffBuy = run?.terms ? tokenInfo(NETWORK, run.terms.makerGives.token) : buy;
  const bondToken = NETWORK.bondToken ? tokenInfo(NETWORK, NETWORK.bondToken) : null;
  const minBond = desk.data && bondToken ? whole(bondToken, desk.data.config.min_bond) : null;

  return (
    <AppShell title="Trade" subtitle="Live prices from Hyperliquid, the makers on the desk, and a request sealed to the matcher enclave, settled privately on NEAR.">
      {/* signed out there is no ticket to draw a payoff from: the makers take its place */}
      <div className="tt-root" data-signed={s.status === "ready" ? "in" : "out"}>
        <InstrumentBar
          pair={pair}
          onPair={(id) => {
            setPref({ pair: id });
            setTicket({ amount: "", min: "" });
          }}
          mid={mid}
          hour={hour}
        />
        <ChartPanel pair={pair} interval={prefs.interval} onInterval={(interval) => setPref({ interval })} mode={prefs.mode} onMode={(mode) => setPref({ mode })} series={series} mid={mid} />
        <Ticket
          pair={pair}
          state={ticket}
          set={setTicket}
          sell={sell}
          buy={buy}
          sellAmount={sellAmount}
          minAmount={minAmount}
          estimate={estimate}
          run={run}
          busy={busy}
          now={now}
          onAsk={() => {
            if (sellAmount === null || minAmount === null) return;
            void ask({ kind: ticket.kind, sell: { token: sell.id, amount: sellAmount }, buy: { token: buy.id, minAmount } }, Number(ticket.windowMs));
          }}
          onReset={() => {
            reset();
            setTicket({ amount: "", min: "" });
          }}
        />
        {s.status === "ready" && <Payoff model={model} kind={run ? run.draft.kind : ticket.kind} buy={payoffBuy} minBondUsd={minBond} />}
        <Workspace runs={runs} now={now || clock} views={views.data} />
        <Makers desk={desk} now={clock} />
        <StatusBar net={net} pricesAt={mids.data?.at ?? 0} />
      </div>
    </AppShell>
  );
}
