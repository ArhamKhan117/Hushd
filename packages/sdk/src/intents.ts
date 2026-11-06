/**
 * NEAR Intents for agents.
 *
 * - The verifier contract (`intents.near`): two accounts trade directly by each signing a
 *   `token_diff` (NEP-413), and either submits both with `execute_intents`; both legs
 *   happen or neither does. Deposits are `ft_transfer_call`s to the verifier; withdrawals
 *   are `ft_withdraw` intents.
 * - The 1Click API: solver quotes and cross-chain swaps (38 chains), settled confidentially.
 *
 * Signing here takes a raw ed25519 secret (an agent's own key); submitting a transaction
 * is the caller's (its own NEAR client), so the same code runs on mainnet and on a sandbox
 * with the verifier deployed.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";
import type { HushdNetwork } from "./network.js";
import { RpcError, view } from "./rpc.js";

/** Mainnet ids: the verifier and the two tokens the agents trade. */
export const INTENTS_MAINNET = {
  verifier: "intents.near",
  usdc: { id: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", symbol: "USDC", decimals: 6 },
  wnear: { id: "wrap.near", symbol: "wNEAR", decimals: 24 },
  oneClick: "https://1click.chaindefuser.com",
  explorer: "https://explorer.near-intents.org",
} as const;

/** Multi-token id of a NEP-141 token inside the verifier. */
export const mt = (token: string) => `nep141:${token}`;

export type Intent =
  | { intent: "token_diff"; diff: Record<string, string>; memo?: string }
  | { intent: "ft_withdraw"; token: string; receiver_id: string; amount: string; memo?: string; msg?: string; storage_deposit?: string }
  | { intent: "transfer"; receiver_id: string; tokens: Record<string, string>; memo?: string };

/** What `execute_intents` and `simulate_intents` take, one per signer. */
export interface MultiPayload {
  standard: "nep413";
  payload: { message: string; nonce: string; recipient: string };
  public_key: string;
  signature: string;
}

const NEP413_TAG = 2 ** 31 + 413;
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const str = (s: string) => {
  const b = new TextEncoder().encode(s);
  return concat(u32(b.length), b);
};
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
const hexToBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** NEP-413: sha256(u32 tag || borsh(message, nonce[32], recipient, callback_url = None)). */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string): Uint8Array {
  if (nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  return sha256(concat(u32(NEP413_TAG), str(message), nonce, str(recipient), Uint8Array.of(0)));
}

/** A nonce's 15 "random" bytes the way NEAR Intents' own SDK makes them: the signing time in ns (i64 LE), then 7 random bytes. 1Click's sign-in checks that time. */
export function timestampedRandom(nowMs: number = Date.now()): Uint8Array {
  const b = new Uint8Array(15);
  new DataView(b.buffer).setBigInt64(0, BigInt(nowMs) * 1_000_000n, true);
  crypto.getRandomValues(b.subarray(8));
  return b;
}

/** A versioned (V1) verifier nonce: magic, version 0, the contract's current salt, the deadline in ns, 15 random bytes. */
export function intentNonce(saltHex: string, deadlineMs: number, random: Uint8Array = timestampedRandom()): Uint8Array {
  if (!/^[0-9a-f]{8}$/i.test(saltHex)) throw new Error("the verifier's salt is 4 bytes of hex");
  if (random.length !== 15) throw new Error("15 random bytes");
  const deadline = new Uint8Array(8);
  new DataView(deadline.buffer).setBigInt64(0, BigInt(deadlineMs) * 1_000_000n, true);
  return concat(hexToBytes("5628f6c6"), Uint8Array.of(0), hexToBytes(saltHex), deadline, random);
}

/** The implicit account id of an ed25519 secret (its public key in hex). */
export function implicitAccount(secret: Uint8Array): string {
  return Array.from(ed25519.getPublicKey(secret), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sign intents for `signerId` with an ed25519 secret, for one verifier, valid until `deadlineMs`. */
export function signIntents(o: { signerId: string; secret: Uint8Array; verifier: string; salt: string; deadlineMs: number; intents: Intent[]; random?: Uint8Array }): MultiPayload {
  // the message deadline and the nonce's deadline must be the same instant (the nonce's may not be earlier)
  const message = JSON.stringify({ signer_id: o.signerId, deadline: new Date(o.deadlineMs).toISOString(), intents: o.intents });
  const nonce = intentNonce(o.salt, o.deadlineMs, o.random);
  const signature = ed25519.sign(nep413Hash(message, nonce, o.verifier), o.secret);
  return {
    standard: "nep413",
    payload: { message, nonce: base64.encode(nonce), recipient: o.verifier },
    public_key: `ed25519:${base58.encode(ed25519.getPublicKey(o.secret))}`,
    signature: `ed25519:${base58.encode(signature)}`,
  };
}

/** The verifier's fee on an amount: ceil(|amount| x fee / 1,000,000), fee in pips. */
export function intentsFee(amount: bigint, feePips: number): bigint {
  const a = amount < 0n ? -amount : amount;
  return (a * BigInt(feePips) + 999_999n) / 1_000_000n;
}

/**
 * The two diffs of a direct trade: A gives `give` and receives `take` from B. The fee is
 * charged on each negative delta, so each side asks for what the other gives less its fee.
 */
export function tradeDiffs(o: { give: { token: string; amount: bigint }; take: { token: string; amount: bigint }; feePips: number }): { a: Record<string, string>; b: Record<string, string> } {
  if (o.give.token === o.take.token) throw new Error("a trade needs two different tokens");
  if (o.give.amount <= 0n || o.take.amount <= 0n) throw new Error("amounts must be positive");
  const takeNet = o.take.amount - intentsFee(o.take.amount, o.feePips);
  const giveNet = o.give.amount - intentsFee(o.give.amount, o.feePips);
  if (takeNet <= 0n || giveNet <= 0n) throw new Error("an amount is too small to pay the fee");
  return {
    a: { [mt(o.give.token)]: `-${o.give.amount}`, [mt(o.take.token)]: `${takeNet}` },
    b: { [mt(o.give.token)]: `${giveNet}`, [mt(o.take.token)]: `-${o.take.amount}` },
  };
}

export interface SimulateResult {
  intents_executed: { intent_hash: string; account_id: string; nonce: string }[];
  logs: string[];
  min_deadline: string;
  invariant_violated?: { error: string; unmatched_deltas?: Record<string, string> };
  state: { fee: number; current_salt: string };
}

/** The contract's own words from a failed view (a panic), or the RPC error's. */
function viewError(e: unknown): Error {
  if (!(e instanceof RpcError)) return e as Error;
  const body = e.cause as { data?: unknown; cause?: { info?: { error?: unknown; vm_error?: unknown } } } | undefined;
  const raw = String(body?.cause?.info?.vm_error ?? body?.cause?.info?.error ?? body?.data ?? e.message);
  const panic = /panic_msg: "(.*?)"/.exec(raw)?.[1] ?? /panicked: (.*?)(["\\]|$)/.exec(raw)?.[1];
  return new Error(panic ?? raw);
}

/** Reads from the verifier (views cost nothing). */
export const verifierView = {
  fee: (net: HushdNetwork, verifier: string) => view<number>(net, verifier, "fee"),
  salt: (net: HushdNetwork, verifier: string) => view<string>(net, verifier, "current_salt"),
  hasPublicKey: (net: HushdNetwork, verifier: string, account: string, publicKey: string) => view<boolean>(net, verifier, "has_public_key", { account_id: account, public_key: publicKey }),
  /** Balances inside the verifier, by NEP-141 token id. */
  async balances(net: HushdNetwork, verifier: string, account: string, tokens: string[]): Promise<Record<string, bigint>> {
    const raw = await view<string[]>(net, verifier, "mt_batch_balance_of", { account_id: account, token_ids: tokens.map(mt) });
    return Object.fromEntries(tokens.map((t, i) => [t, BigInt(raw[i] ?? "0")]));
  },
  /** Dry-run signed intents exactly as `execute_intents` would; throws the verifier's reason when it would refuse. */
  async simulate(net: HushdNetwork, verifier: string, signed: MultiPayload[]): Promise<SimulateResult> {
    try {
      return await view<SimulateResult>(net, verifier, "simulate_intents", { signed });
    } catch (e) {
      throw viewError(e);
    }
  },
};

/** A function call for the caller's own NEAR client to send. */
export interface CallSpec {
  receiver: string;
  method: string;
  args: Record<string, unknown>;
  gas: bigint;
  deposit: bigint;
}

const TGAS = 1_000_000_000_000n;
/** NEP-145 storage on a NEP-141 token: what wrap.near and USDC ask for. */
export const FT_STORAGE = 1_250_000_000_000_000_000_000n;

/** The calls an agent sends around a trade. */
export const verifierCalls = {
  /** Register `account` on a token (to receive withdrawals). */
  storageDeposit: (token: string, account: string): CallSpec => ({ receiver: token, method: "storage_deposit", args: { account_id: account, registration_only: true }, gas: 30n * TGAS, deposit: FT_STORAGE }),
  /** Wrap NEAR into wNEAR. */
  wrap: (wnear: string, yocto: bigint): CallSpec => ({ receiver: wnear, method: "near_deposit", args: {}, gas: 30n * TGAS, deposit: yocto }),
  /** Deposit a token into the verifier, credited to the sender (or to `receiver`). */
  deposit: (verifier: string, token: string, amount: bigint, receiver?: string): CallSpec => ({ receiver: token, method: "ft_transfer_call", args: { receiver_id: verifier, amount: amount.toString(), msg: receiver ?? "" }, gas: 100n * TGAS, deposit: 1n }),
  /** Execute signed intents; anyone may submit them, nothing is attached. */
  execute: (verifier: string, signed: MultiPayload[]): CallSpec => ({ receiver: verifier, method: "execute_intents", args: { signed }, gas: 300n * TGAS, deposit: 0n }),
};

/* ----------------------------------------------------------------- 1Click */

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS" | "CONFIDENTIAL_INTENTS";
  deadline: string;
  confidentiality?: "basic" | "advanced";
  referral?: string;
  quoteWaitingTimeMs?: number;
}

export interface QuoteResponse {
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd?: string;
    minAmountIn?: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd?: string;
    minAmountOut: string;
    timeEstimate?: number;
    depositAddress?: string;
    deadline?: string;
  };
}

/**
 * The 1Click API. Public dry quotes need nothing. A partner key (`X-API-Key`, from
 * partners.near-intents.org) is needed for confidential quotes and lowers the fee on real
 * swaps. Private balances need a user session: `signIn` with the account's key (an empty
 * intent proves ownership and moves nothing).
 */
export class OneClick {
  private session: string | null = null;
  constructor(
    readonly base: string = INTENTS_MAINNET.oneClick,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
  ) {}

  /** Sign in as `signerId` (its verifier key); later requests carry the session. */
  async signIn(o: { signerId: string; secret: Uint8Array; salt: string; verifier?: string }): Promise<void> {
    const signedData = signIntents({ signerId: o.signerId, secret: o.secret, verifier: o.verifier ?? INTENTS_MAINNET.verifier, salt: o.salt, deadlineMs: Date.now() + 5 * 60_000, intents: [] });
    const r = await this.req<{ accessToken: string }>("/v0/auth/authenticate", { method: "POST", body: { signedData } });
    this.session = r.accessToken;
  }

  private async req<T>(path: string, init?: { method?: string; body?: unknown; session?: boolean }): Promise<T> {
    // the user session rides only on account reads: on other routes a bearer token means a partner key
    const auth: Record<string, string> = {};
    if (init?.session && this.session) auth.authorization = `Bearer ${this.session}`;
    else if (!init?.session && this.apiKey) auth["x-api-key"] = this.apiKey;
    const r = await this.fetchImpl(`${this.base.replace(/\/$/, "")}${path}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json", ...auth },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await r.text();
    const body = text ? (JSON.parse(text) as { message?: string }) : {};
    if (!r.ok) throw new Error(`1Click answered ${r.status}: ${body.message ?? text.slice(0, 200)}`);
    return body as T;
  }

  tokens(): Promise<OneClickToken[]> {
    return this.req("/v0/tokens");
  }

  /** A quote. With `dry: true` nothing is reserved and no deposit address is made. */
  quote(q: QuoteRequest): Promise<QuoteResponse> {
    return this.req("/v0/quote", { method: "POST", body: q });
  }

  /** Private (confidential) balances of the signed-in account. */
  balances(): Promise<{ balances: { tokenId: string; available: string }[] }> {
    if (!this.session) throw new Error("sign in first: private balances need a user session");
    return this.req("/v0/account/balances", { session: true });
  }

  status(depositAddress: string): Promise<{ status: string; swapDetails?: { nearTxHashes?: string[]; amountOut?: string } }> {
    return this.req(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  }

  /** Tell 1Click a deposit was sent (speeds it up; optional). */
  submitDeposit(txHash: string, depositAddress: string): Promise<unknown> {
    return this.req("/v0/deposit/submit", { method: "POST", body: { txHash, depositAddress } });
  }
}

/** A quote request with Hushd's defaults: exact input, 1% slippage, ten minutes, public unless `confidentiality` is set (which needs `signIn`). */
export function quoteRequest(o: Pick<QuoteRequest, "originAsset" | "destinationAsset" | "amount" | "recipient" | "refundTo"> & Partial<QuoteRequest>): QuoteRequest {
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    depositType: "ORIGIN_CHAIN",
    refundType: "ORIGIN_CHAIN",
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
    referral: "hushd",
    ...o,
  };
}
