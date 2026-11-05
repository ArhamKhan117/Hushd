/**
 * The indexer: reads every final block from FastNEAR's free block stream (neardata),
 * keeps the NEP-297 events our contracts log ("standard":"hushd") and the NEP-141
 * events of our tokens, and stores them in Postgres for the app and transparency views.
 *
 * Restart-safe: it resumes from its saved cursor, and every event is keyed by
 * (receipt id, log index), so re-reading a block never duplicates anything. To
 * resync, set INDEXER_FROM_BLOCK below the cursor (or delete the cursor row).
 */
import type { HushdNetwork } from "@hushd/sdk";
import { network, settings } from "./config.js";
import { Db } from "./db.js";
import { app, listen } from "./http.js";

interface NeardataBlock {
  block: { header: { height: number; timestamp_nanosec: string } };
  shards: {
    receipt_execution_outcomes: {
      tx_hash: string | null;
      receipt: { receipt_id: string; receiver_id: string };
      execution_outcome: { outcome: { logs: string[]; status: Record<string, unknown> } };
    }[];
  }[];
}

export interface IndexedEvent {
  receiptId: string;
  logIndex: number;
  blockHeight: number;
  blockMs: number;
  contract: string;
  event: string;
  data: unknown;
  txHash: string | null;
}

/** The events in one block from the contracts we watch, only from successful receipts. */
export function eventsInBlock(b: NeardataBlock, watched: Set<string>): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  const blockMs = Number(BigInt(b.block.header.timestamp_nanosec) / 1_000_000n);
  for (const shard of b.shards) {
    for (const r of shard.receipt_execution_outcomes ?? []) {
      if (!watched.has(r.receipt.receiver_id)) continue;
      const status = r.execution_outcome.outcome.status;
      if (!("SuccessValue" in status) && !("SuccessReceiptId" in status)) continue;
      r.execution_outcome.outcome.logs.forEach((log, i) => {
        if (!log.startsWith("EVENT_JSON:")) return;
        try {
          const e = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard: string; event: string; data: unknown[] };
          if (e.standard !== "hushd" && e.standard !== "nep141") return;
          out.push({
            receiptId: r.receipt.receipt_id,
            logIndex: i,
            blockHeight: b.block.header.height,
            blockMs,
            contract: r.receipt.receiver_id,
            event: e.standard === "nep141" ? `ft_${e.event}` : e.event,
            data: e.data?.[0] ?? null,
            txHash: r.tx_hash,
          });
        } catch {
          /* not JSON: not ours */
        }
      });
    }
  }
  return out;
}

export function neardataBase(net: HushdNetwork): string {
  return settings.str("NEARDATA_URL", net.id === "mainnet" ? "https://mainnet.neardata.xyz" : "https://testnet.neardata.xyz");
}

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
      if (r.status === 404) return null;
      if (r.ok) return (await r.json()) as T;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  throw new Error(`neardata did not answer for ${url}`);
}

export class Indexer {
  head = 0;
  cursor = 0;
  constructor(readonly net: HushdNetwork, readonly db: Db, readonly watched: Set<string>) {}

  async store(events: IndexedEvent[]) {
    for (const e of events) {
      await this.db.q(
        `insert into events (receipt_id, log_index, block_height, block_ms, contract, event, data, tx_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [e.receiptId, e.logIndex, e.blockHeight, e.blockMs, e.contract, e.event, JSON.stringify(e.data), e.txHash],
      );
    }
  }

  /** Process blocks from the cursor up to the final head; returns how many were read. */
  async step(maxBlocks = 200): Promise<number> {
    const last = await getJson<NeardataBlock>(`${neardataBase(this.net)}/v0/last_block/final`);
    if (!last) return 0;
    this.head = last.block.header.height;
    const from = Math.max(await this.startHeight(), 0);
    let h = from;
    while (h <= this.head && h < from + maxBlocks) {
      const b = await getJson<NeardataBlock>(`${neardataBase(this.net)}/v0/block/${h}`);
      if (b) await this.store(eventsInBlock(b, this.watched));
      await this.db.setCursor("indexer", h);
      this.cursor = h;
      h++;
    }
    return h - from;
  }

  private async startHeight(): Promise<number> {
    const saved = await this.db.getCursor("indexer");
    const forced = settings.num("INDEXER_FROM_BLOCK", 0);
    if (forced && (saved === null || forced <= saved)) {
      // a resync request: honoured once, then the cursor moves on from it
      process.env.INDEXER_FROM_BLOCK = "";
      return forced;
    }
    if (saved !== null) return saved + 1;
    return this.head - 10;
  }
}

export function watchedContracts(net: HushdNetwork): Set<string> {
  return new Set([net.pool, net.desk, net.board, ...net.tokens.map((t) => t.id)].filter((x): x is string => !!x));
}

export async function startIndexer() {
  const net = network();
  const db = new Db(settings.databaseUrl());
  await db.migrate();
  const ix = new Indexer(net, db, watchedContracts(net));
  const a = app("indexer", async () => ({ cursor: ix.cursor, head: ix.head, behind: ix.head - ix.cursor }));
  listen(a, settings.port("indexer", 8789), "indexer");
  for (;;) {
    try {
      const n = await ix.step();
      if (n === 0 || ix.head - ix.cursor < 2) await new Promise((r) => setTimeout(r, 1_000));
    } catch (e) {
      console.error("indexer:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
