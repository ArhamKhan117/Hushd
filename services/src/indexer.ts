/**
 * The indexer: keeps the NEP-297 events our contracts log ("standard":"hushd") and the
 * NEP-141 events of our tokens, and stores them in Postgres for the app and transparency
 * views. Two sources, both from FastNEAR:
 *
 * - "transactions" (the default, free): FastNEAR's transactions API lists every transaction
 *   that touched each watched contract, with its receipts and logs, so a few requests a
 *   poll keep the index current, including transactions signed by users' own wallets.
 * - "blocks": every final block from the neardata stream. Its free tier reads about 30
 *   blocks a minute, slower than testnet makes them, so this needs NEARDATA_API_KEY.
 * - "rpc": every final block from the RPC node itself (a self-run node or a local
 *   sandbox), with no hosted API: each transaction to a watched contract, with its outcome.
 *
 * Restart-safe: it resumes from its saved cursors, and every event is keyed by
 * (receipt id, log index), so reading a transaction or block twice never duplicates
 * anything. To resync the block stream, set INDEXER_FROM_BLOCK below the cursor.
 */
import type { HushdNetwork } from "@hushd/sdk";
import { latestBlock } from "@hushd/sdk";
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
            // NEP-141 names already read ft_mint, ft_transfer, ft_burn
            event: e.event,
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
      const key = settings.str("NEARDATA_API_KEY", "");
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000), ...(key ? { headers: { authorization: `Bearer ${key}` } } : {}) });
      if (r.status === 404) return null;
      if (r.ok) return (await r.json()) as T;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  throw new Error(`neardata did not answer for ${url}`);
}

/** Hushd and NEP-141 events in a transaction's outcome (what `send` returns), for the services' own sends. */
export function eventsInOutcome(o: OutcomeLike, watched: Set<string>, at: { height: number; ms: number }): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const r of o.receipts_outcome ?? []) {
    const exec = r.outcome;
    if (!exec || !watched.has(exec.executor_id ?? "") || (exec.status as { Failure?: unknown } | undefined)?.Failure) continue;
    (exec.logs ?? []).forEach((log, i) => {
      if (!log.startsWith("EVENT_JSON:")) return;
      try {
        const e = JSON.parse(log.slice(11)) as { standard: string; event: string; data?: unknown[] };
        if (e.standard !== "hushd" && e.standard !== "nep141") return;
        out.push({ receiptId: r.id ?? "", logIndex: i, blockHeight: at.height, blockMs: at.ms, contract: exec.executor_id!, event: e.event, data: e.data?.[0] ?? null, txHash: o.transaction?.hash ?? "" });
      } catch {
        /* not JSON: not ours */
      }
    });
  }
  return out;
}

export interface OutcomeLike {
  transaction?: { hash?: string };
  receipts_outcome?: { id?: string; block_hash?: string; outcome?: { executor_id?: string; logs?: string[]; status?: unknown } }[];
}

export class Indexer {
  head = 0;
  cursor = 0;
  constructor(readonly net: HushdNetwork, readonly db: Db, readonly watched: Set<string>) {}

  async store(events: IndexedEvent[]) {
    await storeEvents(this.db, events);
  }

  /** Process blocks from the cursor up to the final head; returns how many were read. */
  async step(maxBlocks = 200): Promise<number> {
    const last = await getJson<NeardataBlock>(`${neardataBase(this.net)}/v0/last_block/final`);
    if (!last) return 0;
    this.head = last.block.header.height;
    const from = Math.max(await this.startHeight(), 0);
    const to = Math.min(this.head, from + maxBlocks - 1);
    // fetch a window of blocks at once (testnet makes about one a second), store them in order
    for (let start = from; start <= to; start += INDEX_WINDOW) {
      const heights = Array.from({ length: Math.min(INDEX_WINDOW, to - start + 1) }, (_, i) => start + i);
      const blocks = await Promise.all(heights.map((h) => getJson<NeardataBlock>(`${neardataBase(this.net)}/v0/block/${h}`)));
      for (const [i, b] of blocks.entries()) {
        if (b) await this.store(eventsInBlock(b, this.watched));
        await this.db.setCursor("indexer", heights[i]!);
        this.cursor = heights[i]!;
      }
    }
    return to >= from ? to - from + 1 : 0;
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

// neardata rate-limits bursts: a few blocks at a time
const INDEX_WINDOW = 4;

export function txApiBase(net: HushdNetwork): string {
  return settings.str("FASTNEAR_TX_URL", net.id === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com");
}

export interface AccountTx {
  transaction_hash: string;
  tx_block_height: number;
  is_event_log?: boolean;
}

export interface FullTx {
  transaction: { hash: string };
  receipts: { execution_outcome: { id: string; block_height: number; block_timestamp: number; outcome: { logs: string[]; executor_id: string; status: Record<string, unknown> } } }[];
}

/** The events in one transaction (as the transactions API returns it), only from successful receipts of watched contracts. */
export function eventsInTx(t: FullTx, watched: Set<string>): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const { execution_outcome: x } of t.receipts ?? []) {
    if (!watched.has(x.outcome.executor_id)) continue;
    const status = x.outcome.status;
    if (!("SuccessValue" in status) && !("SuccessReceiptId" in status)) continue;
    x.outcome.logs.forEach((log, i) => {
      if (!log.startsWith("EVENT_JSON:")) return;
      try {
        const e = JSON.parse(log.slice("EVENT_JSON:".length)) as { standard: string; event: string; data?: unknown[] };
        if (e.standard !== "hushd" && e.standard !== "nep141") return;
        out.push({ receiptId: x.id, logIndex: i, blockHeight: x.block_height, blockMs: Math.floor(x.block_timestamp / 1e6), contract: x.outcome.executor_id, event: e.event, data: e.data?.[0] ?? null, txHash: t.transaction.hash });
      } catch {
        /* not JSON: not ours */
      }
    });
  }
  return out;
}

async function postJson<T>(url: string, body: object): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
      if (r.ok) return (await r.json()) as T;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  throw new Error(`${url} did not answer`);
}

/** Indexes from the transactions API: per watched contract, the transactions since its cursor. */
export class TxIndexer {
  head = 0;
  /** The chain head when the last poll began: everything up to it is indexed. */
  cursor = 0;
  constructor(readonly net: HushdNetwork, readonly db: Db, readonly watched: Set<string>, readonly finalHeight: () => Promise<number>) {}

  /** New transactions of one account above `after`, oldest first, paging back while pages are full. */
  async newTxs(account: string, after: number): Promise<AccountTx[]> {
    const out: AccountTx[] = [];
    let max: number | null = null;
    for (;;) {
      const page = (await postJson<{ account_txs: AccountTx[] }>(`${txApiBase(this.net)}/v0/account`, { account_id: account, max_block_height: max })).account_txs ?? [];
      const fresh = page.filter((t) => t.tx_block_height > after);
      out.push(...fresh);
      const oldest = Math.min(...page.map((t) => t.tx_block_height));
      if (page.length < TX_PAGE || fresh.length < page.length || !Number.isFinite(oldest)) break;
      max = oldest - 1;
    }
    return out.reverse();
  }

  async step(): Promise<number> {
    const head = await this.finalHeight();
    const byHash = new Map<string, number>();
    const tops = new Map<string, number>();
    for (const account of this.watched) {
      const after = (await this.db.getCursor(`tx:${account}`)) ?? 0;
      const txs = await this.newTxs(account, after);
      for (const t of txs) if (t.is_event_log !== false) byHash.set(t.transaction_hash, t.tx_block_height);
      if (txs.length) tops.set(account, Math.max(...txs.map((t) => t.tx_block_height)));
    }
    const hashes = [...byHash.keys()];
    for (let i = 0; i < hashes.length; i += 20) {
      const { transactions } = await postJson<{ transactions: FullTx[] }>(`${txApiBase(this.net)}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) });
      for (const t of transactions ?? []) await storeEvents(this.db, eventsInTx(t, this.watched));
    }
    // cursors move only after the events are stored, so a crash re-reads instead of skipping
    for (const [account, top] of tops) await this.db.setCursor(`tx:${account}`, top);
    this.head = head;
    this.cursor = head;
    return hashes.length;
  }
}

/** Indexes from the RPC node: the chunks of each final block, then every transaction sent to a watched contract. */
export class RpcIndexer {
  head = 0;
  cursor = 0;
  constructor(readonly net: HushdNetwork, readonly db: Db, readonly watched: Set<string>) {}

  private async rpc<T>(method: string, params: object): Promise<T | null> {
    const r = await postJson<{ result?: T; error?: unknown }>(this.net.rpc[0]!, { jsonrpc: "2.0", id: 1, method, params });
    return r.result ?? null;
  }

  async step(maxBlocks = 50): Promise<number> {
    this.head = await finalHeight(this.net);
    const saved = await this.db.getCursor("indexer:rpc");
    const from = saved !== null ? saved + 1 : Math.max(settings.num("INDEXER_FROM_BLOCK", 0) || this.head - 10, 0);
    const to = Math.min(this.head, from + maxBlocks - 1);
    for (let h = from; h <= to; h++) {
      // a height with no block (skipped) has nothing to index
      const block = await this.rpc<{ header: { timestamp: number }; chunks: { chunk_hash: string; height_included: number }[] }>("block", { block_id: h });
      for (const c of block?.chunks.filter((x) => x.height_included === h) ?? []) {
        const chunk = await this.rpc<{ transactions: { hash: string; signer_id: string; receiver_id: string }[] }>("chunk", { chunk_id: c.chunk_hash });
        for (const tx of chunk?.transactions ?? []) {
          if (!this.watched.has(tx.receiver_id)) continue;
          const outcome = await this.rpc<OutcomeLike>("EXPERIMENTAL_tx_status", { tx_hash: tx.hash, sender_account_id: tx.signer_id, wait_until: "FINAL" });
          if (outcome) await storeEvents(this.db, eventsInOutcome(outcome, this.watched, { height: h, ms: Math.floor(block!.header.timestamp / 1e6) }));
        }
      }
      await this.db.setCursor("indexer:rpc", h);
      this.cursor = h;
    }
    return to >= from ? to - from + 1 : 0;
  }
}

// the transactions API returns up to this many per page
const TX_PAGE = 200;

async function storeEvents(db: Db, events: IndexedEvent[]) {
  for (const e of events) {
    await db.q(
      `insert into events (receipt_id, log_index, block_height, block_ms, contract, event, data, tx_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
      [e.receiptId, e.logIndex, e.blockHeight, e.blockMs, e.contract, e.event, JSON.stringify(e.data), e.txHash],
    );
  }
}

export function watchedContracts(net: HushdNetwork): Set<string> {
  return new Set([net.pool, net.desk, net.board, ...net.tokens.map((t) => t.id)].filter((x): x is string => !!x));
}

export async function startIndexer() {
  const net = network();
  const db = new Db(settings.databaseUrl());
  await db.migrate();
  const watched = watchedContracts(net);
  const source = settings.str("INDEXER_SOURCE", "transactions");
  const ix = source === "blocks" ? new Indexer(net, db, watched) : source === "rpc" ? new RpcIndexer(net, db, watched) : new TxIndexer(net, db, watched, () => finalHeight(net));
  const a = app("indexer", async () => ({ source, cursor: ix.cursor, head: ix.head, behind: ix.head - ix.cursor }));
  listen(a, settings.port("indexer", 8789), "indexer");
  for (;;) {
    try {
      const n = await ix.step();
      if (ix instanceof TxIndexer) await new Promise((r) => setTimeout(r, settings.num("INDEXER_POLL_MS", 4_000)));
      else if (n === 0 || ix.head - ix.cursor < 2) await new Promise((r) => setTimeout(r, 1_000));
    } catch (e) {
      console.error("indexer:", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

async function finalHeight(net: HushdNetwork): Promise<number> {
  return (await latestBlock(net)).height;
}
