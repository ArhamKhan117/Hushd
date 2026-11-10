/**
 * Hushd agents on the NEAR Intents Agent API (mainnet only; a partner key from
 * partners.near-intents.org). Each agent is an OutLayer-custody account on NEAR Intents:
 * its owner signs the policy once, the agent swaps, transfers and withdraws inside it with
 * a grant token, and the owner can freeze it.
 *
 * The owner here is a NEAR key Hushd holds (the mainnet demo's dev wallet), so it signs the
 * owner actions itself: NEP-413 messages, and NEP-366 delegate actions the API's sponsor
 * submits. Only types come from the SDK at load time, so this file also loads on Node 22;
 * `agentApi()` loads the client itself (Node 24).
 */
import type { AgentApi, GenerateIntentResponse, Intent, OwnerWallet, Policy, SignedData, StatusResponse } from "@near-intents-agent-api/sdk";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { implicitAccount, keepRpcErrorBodies, nep413Hash, sendEndpoints, type HushdNetwork } from "@hushd/sdk";
import { Near } from "near-kit";

export const AGENT_API_WNEAR = "nep141:wrap.near";
export const AGENT_API_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export async function agentApi(apiKey: string, baseUrl?: string): Promise<AgentApi> {
  const { createAgentApi } = await import("@near-intents-agent-api/sdk");
  return createAgentApi({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}

export interface OwnerKey {
  accountId: string;
  publicKey: string;
  secret: Uint8Array;
}

/** An implicit NEAR account's key, the owner of the agents. */
export function ownerKey(secret: Uint8Array): OwnerKey {
  return { accountId: implicitAccount(secret), publicKey: `ed25519:${base58.encode(ed25519.getPublicKey(secret))}`, secret };
}

export function ownerWallet(o: OwnerKey): OwnerWallet {
  return { type: "near", account_id: o.accountId, public_key: o.publicKey };
}

/**
 * The rules a Hushd demo agent runs under: swap, transfer and withdraw, only wNEAR and USDC,
 * per-transaction caps, a daily USD budget, transfers only to the listed NEAR Intents
 * accounts and withdrawals only to the listed NEAR accounts.
 */
export function hushdAgentPolicy(o: { transferTo: string[]; withdrawTo: string[]; dailyUsd: string; perTransaction: Record<string, string>; frozen?: boolean }): Policy {
  return {
    frozen: o.frozen ?? false,
    actions: ["swap", "transfer", "withdraw"],
    confidential: false,
    owner_approval: false,
    assets: [AGENT_API_WNEAR, AGENT_API_USDC],
    limits: { per_transaction: o.perTransaction },
    max_actions_per_hour: 30,
    destinations: {
      mode: "only",
      list: [
        ...o.transferTo.map((address) => ({ action: "transfer" as const, address, confidential: false })),
        ...o.withdrawTo.map((address) => ({ action: "withdraw" as const, chain: "near", address, memo: null })),
      ],
    },
    budget: { daily_usd: o.dailyUsd, weekly_usd: null, monthly_usd: null },
    timelock_ms: 0,
  };
}

/** Fixed nonce and expiry for a delegate action, so it can be signed without asking the chain (tests). */
export interface DelegateAt {
  nonce: bigint;
  maxBlockHeight: bigint;
}

/**
 * The owner's signature over what the API asks it to sign, exactly as returned: a NEP-413
 * message, or a NEP-366 delegate action whose calls the API's sponsor sends for the owner.
 */
export async function signOwnerIntent(intent: Intent, owner: OwnerKey, net: HushdNetwork, at?: DelegateAt): Promise<SignedData> {
  switch (intent.standard) {
    case "nep413": {
      const { message, recipient, nonce } = intent.payload;
      const signature = ed25519.sign(nep413Hash(message, base64.decode(nonce), recipient), owner.secret);
      return { ...intent, public_key: owner.publicKey, signature: base64.encode(signature) };
    }
    case "nep366": {
      keepRpcErrorBodies(net);
      const near = new Near({
        network: { networkId: net.id, rpcUrl: sendEndpoints(net)[0]! },
        privateKey: `ed25519:${base58.encode(new Uint8Array([...owner.secret, ...ed25519.getPublicKey(owner.secret)]))}`,
        defaultSignerId: owner.accountId,
      });
      let tx = near.transaction(owner.accountId);
      for (const a of intent.payload.actions) {
        tx = tx.functionCall(intent.payload.receiverId, a.params.methodName, a.params.args, { gas: a.params.gas as `${number}`, attachedDeposit: BigInt(a.params.deposit) });
      }
      const { payload } = await tx.delegate({ receiverId: intent.payload.receiverId, publicKey: owner.publicKey, ...(at ? { nonce: at.nonce, maxBlockHeight: at.maxBlockHeight } : {}) });
      return { ...intent, signed_delegate: payload };
    }
    default:
      throw new Error(`The owner signs with a NEAR key, not ${intent.standard}`);
  }
}

/** Follow an operation to its end (the status call long-polls for up to 30 s). */
export async function settled(api: AgentApi, correlationId: string, timeoutMs = 5 * 60_000): Promise<StatusResponse> {
  const start = Date.now();
  for (;;) {
    const s = await api.getStatus(correlationId, { waitMs: 30_000 });
    if (s.status !== "PROCESSING" && s.status !== "QUEUED") return s;
    if (Date.now() - start > timeoutMs) throw new Error(`${correlationId} is still ${s.status}`);
  }
}

/** Prepare an owner action, sign it with the owner key, submit it and wait for the outcome. */
export async function ownerAction(api: AgentApi, owner: OwnerKey, net: HushdNetwork, generated: GenerateIntentResponse): Promise<StatusResponse> {
  const signed = await signOwnerIntent(generated.intent, owner, net);
  await api.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: signed });
  const status = await settled(api, generated.correlation_id);
  if (status.status !== "SUCCESS") throw new Error(`${generated.type} ended ${status.status}${"failure_code" in status && status.failure_code ? `: ${status.failure_code}` : ""}`);
  return status;
}
