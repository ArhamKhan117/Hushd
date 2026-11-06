/**
 * Agent policy wallets on OutLayer custody.
 *
 * The agent's NEAR key is made and kept inside OutLayer's TEE; the agent holds only an API
 * key (`wk_...`). Every transaction it asks for is checked against its owner's policy in the
 * enclave before it is signed. The owner stores the policy, encrypted, on chain
 * (`store_wallet_policy` on outlayer.testnet), and alone can freeze the wallet
 * (`freeze_wallet`), which the enclave reads on every signature.
 *
 * For contract calls the enclave enforces: which transaction types, which contracts
 * (an allowlist), NEAR attached per transaction and per day, calls per hour, hours of the
 * day, and the freeze. It does not decode call arguments, so token amounts inside a call
 * are capped by Hushd's own limits on top (the MCP server's per-payment and per-day limits).
 */
import type { HushdNetwork } from "./network.js";
import type { CallSpec } from "./intents.js";
import { view } from "./rpc.js";

export const CUSTODY: Record<HushdNetwork["id"], { api: string; contract: string }> = {
  testnet: { api: "https://testnet-api.outlayer.ai", contract: "outlayer.testnet" },
  mainnet: { api: "https://api.outlayer.ai", contract: "outlayer.near" },
};

/** The policy rules OutLayer's enclave evaluates (amounts in yoctoNEAR). */
export interface PolicyRules {
  transaction_types: ("call" | "transfer" | "withdraw" | "delete" | "swap")[];
  allowed_tokens: string[];
  addresses: { mode: "whitelist" | "blacklist" | "none"; list: string[] };
  limits?: { per_transaction?: Record<string, string>; hourly?: Record<string, string>; daily?: Record<string, string>; monthly?: Record<string, string> };
  rate_limit?: { max_per_hour: number };
  time_restrictions?: { timezone: "UTC"; allowed_hours?: [number, number]; allowed_days?: number[] };
}

export interface AgentPolicy {
  /** NEAR attached to one call, at most. */
  perTxYocto: bigint;
  /** NEAR attached per day, at most. */
  dailyYocto: bigint;
  maxPerHour: number;
  /** UTC hours the wallet may sign in, inclusive. */
  hours?: [number, number];
  /** Contracts it may call (default: every Hushd contract on the network). */
  contracts?: string[];
}

/** The rules for a Hushd agent: contract calls only, to Hushd's contracts only, with NEAR, rate and hour caps. */
export function hushdPolicyRules(net: HushdNetwork, p: AgentPolicy): PolicyRules {
  const contracts = p.contracts ?? [net.pool, net.desk, net.board, ...net.tokens.map((t) => t.id)].filter((x): x is string => !!x);
  return {
    transaction_types: ["call"],
    allowed_tokens: ["native"],
    addresses: { mode: "whitelist", list: contracts },
    limits: { per_transaction: { native: p.perTxYocto.toString() }, daily: { native: p.dailyYocto.toString() } },
    rate_limit: { max_per_hour: p.maxPerHour },
    ...(p.hours ? { time_restrictions: { timezone: "UTC", allowed_hours: p.hours } } : {}),
  };
}

export interface PolicyView {
  wallet_id: string;
  controller: string | null;
  frozen: boolean;
  policy: "none" | "stored";
  rules: PolicyRules | null;
  usage: Record<string, unknown>;
}

/** A refusal from the wallet: the policy said no, or the owner froze it. */
export class PolicyRefusal extends Error {
  constructor(
    readonly code: "policy_denied" | "wallet_frozen" | "wallet_busy" | "operation_limit_reached" | string,
    message: string,
  ) {
    super(message);
  }
}

/** One agent's wallet, as the agent sees it: an API key and the calls it may ask for. */
export class CustodyWallet {
  constructor(
    readonly apiKey: string,
    readonly api: string = CUSTODY.testnet.api,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  /** A new wallet. Whoever holds the key can sign its first policy: store it before handing the key to an agent. */
  static async register(api: string = CUSTODY.testnet.api, fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Promise<{ wallet: CustodyWallet; walletId: string; accountId: string }> {
    const r = await fetchImpl(`${api}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = (await r.json()) as { api_key?: string; wallet_id?: string; near_account_id?: string; message?: string };
    if (!r.ok || !body.api_key) throw new Error(`OutLayer did not register a wallet: ${body.message ?? r.status}`);
    return { wallet: new CustodyWallet(body.api_key, api, fetchImpl), walletId: body.wallet_id!, accountId: body.near_account_id! };
  }

  private async req<T>(path: string, init?: { method?: string; body?: unknown; idempotent?: boolean }): Promise<T> {
    const r = await this.fetchImpl(`${this.api}${path}`, {
      method: init?.method ?? "GET",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...(init?.idempotent ? { "x-idempotency-key": crypto.randomUUID() } : {}) },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    const body = (text ? JSON.parse(text) : {}) as { error?: string; message?: string };
    if (r.status === 403 || r.status === 409 || r.status === 429) throw new PolicyRefusal(body.error ?? String(r.status), body.message ?? text);
    if (!r.ok) throw new Error(`OutLayer answered ${r.status}: ${body.message ?? text.slice(0, 200)}`);
    return body as T;
  }

  /** The wallet's NEAR account (an implicit account) and its public key, `ed25519:<hex>` as OutLayer spells it. */
  async address(): Promise<{ walletId: string; accountId: string; publicKey: string }> {
    const a = await this.req<{ wallet_id: string; address: string; public_key: string }>("/wallet/v1/address?chain=near");
    return { walletId: a.wallet_id, accountId: a.address, publicKey: a.public_key };
  }

  policy(): Promise<PolicyView> {
    return this.req("/wallet/v1/policy");
  }

  /** Ask the wallet to sign and send one function call; the enclave checks the policy first. */
  async call(c: CallSpec): Promise<{ txHash: string; result: unknown }> {
    const r = await this.req<{ status: string; tx_hash: string | null; result: unknown }>("/wallet/v1/call", {
      method: "POST",
      idempotent: true,
      body: { receiver_id: c.receiver, method_name: c.method, args: c.args, gas: c.gas.toString(), deposit: c.deposit.toString() },
    });
    if (r.status === "pending_approval") throw new PolicyRefusal("pending_approval", "The call waits for the owner's approval");
    if (r.status !== "success" || !r.tx_hash) throw new Error(`The wallet's call ${c.receiver}.${c.method} ended ${r.status}`);
    return { txHash: r.tx_hash, result: r.result };
  }

  /** Step 1 of setting a policy: the wallet encrypts the rules to its enclave. */
  async encryptPolicy(walletId: string, rules: PolicyRules): Promise<string> {
    return (await this.req<{ encrypted_base64: string }>("/wallet/v1/encrypt-policy", { method: "POST", body: { wallet_id: walletId, rules } })).encrypted_base64;
  }

  /** Step 2: the wallet signs the encrypted policy for the one account that will store it (the owner). */
  async signPolicy(encrypted: string, owner: string): Promise<{ signatureHex: string; publicKeyHex: string }> {
    const r = await this.req<{ signature_hex: string; public_key_hex: string }>("/wallet/v1/sign-policy", { method: "POST", body: { encrypted_data: encrypted, caller: owner } });
    return { signatureHex: r.signature_hex, publicKeyHex: r.public_key_hex };
  }

  /** Step 4: after the owner's transaction, make the enclave read the new policy now. */
  async refresh(walletId: string): Promise<void> {
    await this.req("/wallet/v1/invalidate-cache", { method: "POST", body: { wallet_id: walletId } });
  }
}

/** Step 3, sent by the owner's own wallet: store the policy on chain (the first sender becomes its controller). */
export function storePolicyCall(contract: string, publicKeyHex: string, encrypted: string, signatureHex: string, depositYocto: bigint): CallSpec {
  return { receiver: contract, method: "store_wallet_policy", args: { wallet_pubkey: `ed25519:${publicKeyHex}`, encrypted_data: encrypted, wallet_signature: signatureHex }, gas: 50_000_000_000_000n, deposit: depositYocto };
}

/** The owner freezes the wallet: the enclave refuses every signature until `unfreezeCall`. */
export const freezeCall = (contract: string, walletPubkey: string): CallSpec => ({ receiver: contract, method: "freeze_wallet", args: { wallet_pubkey: walletPubkey }, gas: 30_000_000_000_000n, deposit: 0n });
export const unfreezeCall = (contract: string, walletPubkey: string): CallSpec => ({ receiver: contract, method: "unfreeze_wallet", args: { wallet_pubkey: walletPubkey }, gas: 30_000_000_000_000n, deposit: 0n });

/** What anyone can read on chain: who controls a wallet's policy and whether it is frozen (the rules stay encrypted). */
export const custodyView = {
  async policy(net: HushdNetwork, walletPubkey: string): Promise<{ owner: string; frozen: boolean; updatedAtMs: number } | null> {
    const v = await view<{ owner: string; frozen: boolean; updated_at: number } | null>(net, CUSTODY[net.id].contract, "get_wallet_policy", { wallet_pubkey: walletPubkey });
    return v ? { owner: v.owner, frozen: v.frozen, updatedAtMs: Math.floor(v.updated_at / 1e6) } : null;
  },
  /** The storage deposit `store_wallet_policy` needs, in yoctoNEAR. */
  async cost(net: HushdNetwork, walletPubkey: string, encrypted: string): Promise<bigint> {
    return BigInt(await view<string>(net, CUSTODY[net.id].contract, "estimate_wallet_policy_cost", { wallet_pubkey: walletPubkey, encrypted_data: encrypted }));
  },
};

/** An implicit account's wallet key in OutLayer's spelling. */
export const custodyPubkey = (implicitAccountId: string) => `ed25519:${implicitAccountId}`;
