/**
 * Signing for a service account with near-kit. With a gas key configured, calls are
 * spread over its nonce lanes so many transactions are in flight at once without
 * nonce collisions; without one, the account's full-access key sends them in turn.
 */
import { accountBalance, keepRpcErrorBodies, restEndpoint, rpcOrder, sendEndpoints, type HushdNetwork } from "@hushd/sdk";
import { settings } from "./config.js";
import { Db } from "./db.js";
import { eventsInOutcome, watchedContracts, type OutcomeLike } from "./indexer.js";
import { base58 } from "@scure/base";
import { Near } from "near-kit";
import type { AccountConfig } from "./config.js";

export interface CallResult {
  txHash: string;
  /** The receipt's return value, JSON-decoded when it is JSON. */
  result: unknown;
  gasBurnt: bigint;
  lane: number | null;
}

export class ChainError extends Error {
  constructor(message: string, readonly txHash?: string) {
    super(message);
  }
}

type Outcome = {
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string; outcome?: { gas_burnt?: number } };
  receipts_outcome?: { id?: string; block_hash?: string; outcome?: { gas_burnt?: number; status?: unknown; executor_id?: string; logs?: string[] } }[];
  status?: { SuccessValue?: string; Failure?: unknown };
};

function decodeResult(o: Outcome): unknown {
  const v = o.status?.SuccessValue;
  if (v === undefined || v === "") return null;
  const text = Buffer.from(v, "base64").toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function failureText(f: unknown): string {
  const s = JSON.stringify(f);
  const m = /"(?:panic_msg|ExecutionError|message)"\s*:\s*"([^"]+)"/.exec(s);
  return m ? m[1]!.replace(/^Smart contract panicked: /, "") : s.slice(0, 400);
}

let sink: Promise<Db | null> | null = null;
/** The services share Postgres with the API: each one records the events of its own sends. */
function eventSink(): Promise<Db | null> {
  sink ??= (async () => {
    try {
      const db = new Db(settings.databaseUrl());
      await db.migrate();
      return db;
    } catch {
      return null;
    }
  })();
  return sink;
}

async function recordEvents(net: HushdNetwork, o: Outcome) {
  const db = await eventSink();
  const blockHash = o.receipts_outcome?.[0]?.block_hash;
  if (!db || !blockHash) return;
  const b = await rpcBlock(net, blockHash);
  const at = { height: b.header.height, ms: Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n) };
  for (const e of eventsInOutcome(o as OutcomeLike, watchedContracts(net), at)) {
    await db.q(
      `insert into events (receipt_id, log_index, block_height, block_ms, contract, event, data, tx_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
      [e.receiptId, e.logIndex, e.blockHeight, e.blockMs, e.contract, e.event, JSON.stringify(e.data), e.txHash],
    );
  }
}

async function rpcBlock(net: HushdNetwork, hash: string): Promise<{ header: { height: number; timestamp_nanosec: string } }> {
  const order = [...rpcOrder(net.rpc), ...(net.rpcFallback ?? [])];
  for (const url of [...order, ...order]) {
    const j = (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { block_id: hash } }) })
      .then((r) => r.json())
      .catch(() => ({}))) as { result?: { header: { height: number; timestamp_nanosec: string } } };
    if (j.result) return j.result;
    restEndpoint(url);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no RPC answered for the block");
}

/**
 * How much to move into a gas key: nothing while it holds at least `floor`, else up to
 * `target`. Every transaction sent through the key reserves its full prepaid gas from
 * this balance, so a drained key refuses sends even while the account holds NEAR.
 */
export function gasKeyTopUp(balance: bigint, floor: bigint, target: bigint): bigint {
  return balance >= floor ? 0n : target - balance;
}

/** A refusal before broadcast (rate limit, or a gateway that does not take the call): safe to send again elsewhere. */
const rateLimited = (e: { message?: string; transactionHash?: string }) => !e.transactionHash && /429|too many|rate.?limit|method is not available/i.test(e.message ?? "");

export class Signer {
  /** One client per endpoint that takes transactions; sends rotate across them and fail over when one rate-limits. */
  private readonly clients: Map<string, Near>;
  private readonly sendUrls: string[];
  private lane = 0;
  private stats = { sent: 0, failed: 0, gasBurnt: 0n, perLane: new Map<number, number>() };

  constructor(readonly net: HushdNetwork, readonly cfg: AccountConfig) {
    keepRpcErrorBodies(net);
    this.sendUrls = sendEndpoints(net);
    this.clients = new Map(
      this.sendUrls.map((rpcUrl) => [
        rpcUrl,
        new Near({
          network: { networkId: net.id, rpcUrl },
          privateKey: cfg.privateKey as `ed25519:${string}`,
          defaultSignerId: cfg.accountId,
          defaultWaitUntil: "EXECUTED_OPTIMISTIC",
        }),
      ]),
    );
  }

  get near(): Near {
    return this.clients.get(rpcOrder(this.sendUrls)[0]!)!;
  }

  /** Send any transaction made with a client, failing over on rate limits like `call`. */
  async send<T>(build: (client: Near) => Promise<T>): Promise<T> {
    const order = rpcOrder(this.sendUrls);
    for (let attempt = 0; ; attempt++) {
      const url = order[attempt % order.length]!;
      try {
        return await build(this.clients.get(url)!);
      } catch (e) {
        if (!rateLimited(e as { message?: string; transactionHash?: string }) || attempt >= order.length * 3) throw e;
        restEndpoint(url);
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }

  get accountId(): string {
    return this.cfg.accountId;
  }

  get lanes(): number {
    return this.cfg.gasKey?.lanes ?? 1;
  }

  async call(contract: string, method: string, args: object, opts: { gas?: string; deposit?: bigint | string } = {}): Promise<CallResult> {
    const lane = this.cfg.gasKey ? this.lane++ % this.cfg.gasKey.lanes : null;
    this.stats.sent++;
    if (lane !== null) this.stats.perLane.set(lane, (this.stats.perLane.get(lane) ?? 0) + 1);
    let outcome: Outcome | null = null;
    const order = rpcOrder(this.sendUrls);
    for (let attempt = 0; outcome === null; attempt++) {
      const url = order[attempt % order.length]!;
      const client = this.clients.get(url)!;
      let tx = client.transaction(this.cfg.accountId).functionCall(contract, method, args, {
        gas: (opts.gas ?? "300 Tgas") as `${number} Tgas`,
        attachedDeposit: BigInt(opts.deposit ?? 0),
      });
      if (lane !== null) tx = tx.signWith(this.cfg.gasKey!.privateKey as `ed25519:${string}`).useGasKey(lane);
      try {
        outcome = (await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as unknown as Outcome;
      } catch (e) {
        const err = e as { message?: string; data?: unknown; transactionHash?: string };
        if (rateLimited(err) && attempt < order.length * 3) {
          restEndpoint(url);
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        this.stats.failed++;
        const onlyStatus = typeof err.data === "object" && err.data !== null && Object.keys(err.data).join() === "statusCode";
        throw new ChainError(err.data && !onlyStatus ? failureText(err.data) : err.message ?? String(e), err.transactionHash);
      }
    }
    const txHash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? "";
    const gasBurnt = BigInt(outcome.transaction_outcome?.outcome?.gas_burnt ?? 0) + (outcome.receipts_outcome ?? []).reduce((s, r) => s + BigInt(r.outcome?.gas_burnt ?? 0), 0n);
    this.stats.gasBurnt += gasBurnt;
    if (outcome.status?.Failure) {
      this.stats.failed++;
      throw new ChainError(failureText(outcome.status.Failure), txHash);
    }
    void recordEvents(this.net, outcome).catch((e) => console.error(`events of ${txHash}: ${(e as Error).message}`));
    return { txHash, result: decodeResult(outcome), gasBurnt, lane };
  }

  /** The gas key's public key, derived from its private key (ed25519: seed ‖ public). */
  get gasKeyPublic(): string | null {
    const sk = this.cfg.gasKey?.privateKey;
    return sk ? `ed25519:${base58.encode(base58.decode(sk.slice(8)).slice(32))}` : null;
  }

  /** The gas key's prepaid balance in yoctoNEAR; null without a gas key, or when no endpoint answers. */
  async gasKeyBalance(): Promise<bigint | null> {
    const pub = this.gasKeyPublic;
    if (!pub) return null;
    for (const url of [...rpcOrder(this.net.rpc), ...(this.net.rpcFallback ?? [])]) {
      const j = (await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: this.cfg.accountId, public_key: pub } }),
      })
        .then((r) => r.json())
        .catch(() => ({}))) as { result?: { permission?: { GasKeyFullAccess?: { balance?: string }; GasKeyFunctionCall?: { balance?: string } } } };
      const p = j.result?.permission;
      const bal = p?.GasKeyFullAccess?.balance ?? p?.GasKeyFunctionCall?.balance;
      if (bal !== undefined) return BigInt(bal);
      restEndpoint(url);
    }
    return null;
  }

  /** Refill the gas key from the account (signed with the account's own key) when it runs below `floor`. */
  async keepGasKeyFunded(floor: bigint, target: bigint): Promise<{ balance: bigint; added: bigint } | null> {
    const pub = this.gasKeyPublic;
    const balance = await this.gasKeyBalance();
    if (!pub || balance === null) return null;
    const added = gasKeyTopUp(balance, floor, target);
    if (added > 0n) await this.send((c) => c.transaction(this.cfg.accountId).transferToGasKey(pub, added).send({ waitUntil: "EXECUTED_OPTIMISTIC" }));
    return { balance: balance + added, added };
  }

  /** The account's balance in yoctoNEAR. */
  async balance(): Promise<bigint> {
    return (await accountBalance(this.net, this.cfg.accountId)) ?? 0n;
  }

  snapshot() {
    return {
      account: this.cfg.accountId,
      lanes: this.lanes,
      sent: this.stats.sent,
      failed: this.stats.failed,
      gasBurnt: this.stats.gasBurnt.toString(),
      perLane: Object.fromEntries(this.stats.perLane),
    };
  }
}
