/**
 * Signing for a service account with near-kit. With a gas key configured, calls are
 * spread over its nonce lanes so many transactions are in flight at once without
 * nonce collisions; without one, the account's full-access key sends them in turn.
 */
import { accountBalance, type HushdNetwork } from "@hushd/sdk";
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
  receipts_outcome?: { outcome?: { gas_burnt?: number; status?: unknown } }[];
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

export class Signer {
  readonly near: Near;
  private lane = 0;
  private stats = { sent: 0, failed: 0, gasBurnt: 0n, perLane: new Map<number, number>() };

  constructor(readonly net: HushdNetwork, readonly cfg: AccountConfig) {
    this.near = new Near({
      network: { networkId: net.id, rpcUrl: net.rpc[0]! },
      privateKey: cfg.privateKey as `ed25519:${string}`,
      defaultSignerId: cfg.accountId,
      defaultWaitUntil: "EXECUTED_OPTIMISTIC",
    });
  }

  get accountId(): string {
    return this.cfg.accountId;
  }

  get lanes(): number {
    return this.cfg.gasKey?.lanes ?? 1;
  }

  async call(contract: string, method: string, args: object, opts: { gas?: string; deposit?: bigint | string } = {}): Promise<CallResult> {
    let tx = this.near.transaction(this.cfg.accountId).functionCall(contract, method, args, {
      gas: (opts.gas ?? "300 Tgas") as `${number} Tgas`,
      attachedDeposit: BigInt(opts.deposit ?? 0),
    });
    let lane: number | null = null;
    if (this.cfg.gasKey) {
      lane = this.lane++ % this.cfg.gasKey.lanes;
      tx = tx.signWith(this.cfg.gasKey.privateKey as `ed25519:${string}`).useGasKey(lane);
    }
    this.stats.sent++;
    if (lane !== null) this.stats.perLane.set(lane, (this.stats.perLane.get(lane) ?? 0) + 1);
    let outcome: Outcome;
    try {
      outcome = (await tx.send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as unknown as Outcome;
    } catch (e) {
      this.stats.failed++;
      const err = e as { message?: string; data?: unknown; transactionHash?: string };
      throw new ChainError(err.data ? failureText(err.data) : err.message ?? String(e), err.transactionHash);
    }
    const txHash = outcome.transaction?.hash ?? outcome.transaction_outcome?.id ?? "";
    const gasBurnt = BigInt(outcome.transaction_outcome?.outcome?.gas_burnt ?? 0) + (outcome.receipts_outcome ?? []).reduce((s, r) => s + BigInt(r.outcome?.gas_burnt ?? 0), 0n);
    this.stats.gasBurnt += gasBurnt;
    if (outcome.status?.Failure) {
      this.stats.failed++;
      throw new ChainError(failureText(outcome.status.Failure), txHash);
    }
    return { txHash, result: decodeResult(outcome), gasBurnt, lane };
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
