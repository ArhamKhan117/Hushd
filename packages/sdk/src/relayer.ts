/**
 * The Hushd relayer's HTTP API. Proven pool actions, board posts and desk actions go
 * through it, so a user's NEAR account never appears as the sender.
 */
import type { TransactRequest } from "./pool.js";

export interface RelayerInfo {
  account: string;
  network: string;
  /** Fee the relayer asks on a cash out, in basis points (0 on testnet). */
  cashOutFeeBps: number;
  /** Methods the relayer will send, per contract. */
  allow: Record<string, string[]>;
  lanes: number;
}

export interface Relayed {
  txHash: string;
  /** The contract's return value, parsed. */
  result?: unknown;
}

export class RelayerError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class RelayerClient {
  // browsers refuse `fetch` called as a method of another object ("Illegal invocation"), so wrap it
  constructor(readonly baseUrl: string, private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private async req<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: text };
    }
    if (!res.ok) throw new RelayerError((json as { error?: string }).error ?? `relayer answered ${res.status}`, res.status);
    return json as T;
  }

  info() {
    return this.req<RelayerInfo>("/v1/relay/info");
  }
  transact(r: TransactRequest) {
    return this.req<Relayed>("/v1/relay/transact", r);
  }
  post(data: string, tag?: string) {
    return this.req<Relayed>("/v1/relay/post", { data, tag });
  }
  openRfq(commitment: string, windowMs: number) {
    return this.req<Relayed & { rfqId: number }>("/v1/relay/rfq", { commitment, windowMs });
  }
  /** Both legs, with both parties' approvals of their four outputs (see `settleMessage`). */
  settle(dealId: number, legs: unknown[], approvals: { trader: string; maker: string }) {
    return this.req<Relayed>("/v1/relay/settle", { dealId, legs, approvals });
  }
  /** Close a hedge: the signature by the deal's owner key is the only authority. */
  closeHedge(dealId: number, signature: string) {
    return this.req<Relayed>("/v1/relay/close-hedge", { dealId, signature });
  }
  /** Testnet only: open a new passkey account with a little NEAR for its own gas. */
  activate(account: string) {
    return this.req<{ activated: boolean; txHash?: string }>("/v1/relay/activate", { account });
  }
  /** Testnet only: faucet tokens for an account (passkey accounts have no gas). */
  faucet(account: string, token: string) {
    return this.req<Relayed>("/v1/relay/faucet", { account, token });
  }
}
