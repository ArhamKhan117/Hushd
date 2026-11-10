/**
 * Read-only NEAR RPC: contract views and account state, with endpoint fallback.
 * No keys and no wallet: this is all a read-only client needs.
 */
import { utf8ToB64 } from "./bytes.js";
import { allEndpoints, type HushdNetwork } from "./network.js";

export class RpcError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

const b64 = utf8ToB64;

// Free endpoints share the load: each call starts at the next one, and one that
// rate-limits, errors or times out rests a while before it is asked first again.
const resting = new Map<string, number>();
let turn = 0;
const REST_MS = 30_000;

/** The endpoints in the order to try them: rotated per call, resting ones last. */
export function rpcOrder(urls: readonly string[], now = Date.now()): string[] {
  if (urls.length < 2) return [...urls];
  const start = turn++ % urls.length;
  const rotated = [...urls.slice(start), ...urls.slice(0, start)];
  const until = (u: string) => resting.get(u) ?? 0;
  return [...rotated.filter((u) => until(u) <= now), ...rotated.filter((u) => until(u) > now).sort((a, b) => until(a) - until(b))];
}

/** Rest an endpoint that rate-limited or failed. */
export function restEndpoint(url: string, ms = REST_MS): void {
  resting.set(url, Date.now() + ms);
}

const errorBodyHosts = new Set<string>();

/**
 * FastNEAR answers a rejected transaction with HTTP 400 and the JSON-RPC error in the body.
 * near-kit drops the body of any non-2xx answer, and with it the reason and its own retry on
 * a stale nonce. After this call, POSTs to these endpoints that fail with a JSON-RPC error body
 * reach near-kit as ordinary answers. Patches `fetch` once; other requests are untouched.
 */
export function keepRpcErrorBodies(endpoints: readonly string[] | HushdNetwork): void {
  const urls = Array.isArray(endpoints) ? endpoints : allEndpoints(endpoints as HushdNetwork);
  const first = errorBodyHosts.size === 0;
  for (const u of urls) errorBodyHosts.add(u.replace(/\/$/, ""));
  if (!first) return;
  const base = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await base(input, init);
    const url = (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).replace(/\/$/, "");
    if (res.status !== 400 || !errorBodyHosts.has(url)) return res;
    const text = await res.text();
    let rpcError = false;
    try {
      rpcError = Boolean((JSON.parse(text) as { error?: unknown }).error);
    } catch {
      /* not JSON-RPC: keep the 400 */
    }
    return new Response(text, { status: rpcError ? 200 : 400, statusText: rpcError ? "OK" : res.statusText, headers: res.headers });
  };
}

async function rpcCall<T>(net: HushdNetwork, method: string, params: unknown): Promise<T> {
  let last: unknown;
  for (const url of [...rpcOrder(net.rpc), ...(net.rpcFallback ?? [])]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "hushd", method, params }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429 || res.status >= 500) throw new RpcError(`${url} answered ${res.status}`);
        const body = (await res.json()) as { result?: T; error?: { code?: number; cause?: { name?: string; info?: { requested_account_id?: string } }; data?: unknown; message?: string } };
        // some providers rate-limit inside a 200 answer: that is an outage, try the next endpoint
        if (body.error?.code === -429) throw new RpcError(`${url} answered 429`);
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
        restEndpoint(url);
        // a rate limit will not lift in a moment: ask the next endpoint rather than this one again
        if (e instanceof RpcError && /answered 429/.test(e.message)) break;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }
  throw last instanceof Error ? last : new RpcError("every RPC endpoint failed", last);
}

/** Call a view method; returns its JSON result. */
export async function view<T>(net: HushdNetwork, contract: string, method: string, args: unknown = {}): Promise<T> {
  const r = await rpcCall<{ result?: number[]; logs: string[]; error?: string }>(net, "query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: b64(JSON.stringify(args)),
  });
  // some nodes answer a contract panic inside the result instead of as an RPC error
  if (r.error !== undefined || !r.result) throw new RpcError(r.error ?? `${contract}.${method} returned nothing`, { data: r.error });
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
