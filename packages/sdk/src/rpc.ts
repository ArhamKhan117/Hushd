/**
 * Read-only NEAR RPC: contract views and account state, with endpoint fallback.
 * No keys and no wallet: this is all a read-only client needs.
 */
import { utf8ToB64 } from "./bytes.js";
import type { HushdNetwork } from "./network.js";

export class RpcError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

const b64 = utf8ToB64;

async function rpcCall<T>(net: HushdNetwork, method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (const url of net.rpc) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "hushd", method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429 || res.status >= 500) throw new RpcError(`${url} answered ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { cause?: { name?: string; info?: { requested_account_id?: string } }; data?: unknown; message?: string } };
        if (body.error) {
          const c = body.error.cause;
          const words = c?.name === "UNKNOWN_ACCOUNT" ? `${c.info?.requested_account_id ?? "That account"} does not exist on NEAR ${net.id} (UNKNOWN_ACCOUNT)` : c?.name ?? body.error.message ?? "RPC error";
          throw new RpcError(words, body.error);
        }
        return body.result as T;
      } catch (e) {
        last = e;
        // contract errors are answers, not outages: no point asking another endpoint
        if (e instanceof RpcError && e.cause && !String(e.message).includes("answered")) throw e;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw last instanceof Error ? last : new RpcError("every RPC endpoint failed", last);
}

/** Call a view method; returns its JSON result. */
export async function view<T>(net: HushdNetwork, contract: string, method: string, args: unknown = {}): Promise<T> {
  const r = await rpcCall<{ result: number[]; logs: string[] }>(net, "query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: b64(JSON.stringify(args)),
  });
  const text = new TextDecoder().decode(Uint8Array.from(r.result));
  return (text ? JSON.parse(text) : null) as T;
}

export async function accountBalance(net: HushdNetwork, account: string): Promise<bigint | null> {
  try {
    const r = await rpcCall<{ amount: string }>(net, "query", { request_type: "view_account", finality: "optimistic", account_id: account });
    return BigInt(r.amount);
  } catch (e) {
    if (e instanceof RpcError && /UNKNOWN_ACCOUNT/.test(e.message)) return null;
    throw e;
  }
}

export async function txStatus(net: HushdNetwork, hash: string, sender: string): Promise<unknown> {
  return rpcCall(net, "tx", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
}

export async function latestBlock(net: HushdNetwork): Promise<{ height: number; timestampMs: number }> {
  const r = await rpcCall<{ header: { height: number; timestamp_nanosec: string } }>(net, "block", { finality: "final" });
  return { height: r.header.height, timestampMs: Number(BigInt(r.header.timestamp_nanosec) / 1_000_000n) };
}
