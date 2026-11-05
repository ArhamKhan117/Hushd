/**
 * Private x402: pay for an HTTP resource from a private balance.
 *
 * A resource answers 402 with an `accepts` entry of scheme "hushd" (the price, the
 * token and a hushd1… address to pay). The client pays it with a private send, then
 * retries with an `X-PAYMENT` header carrying the transaction hash, the payment note's
 * commitment and the note's opening sealed to the payee. The server opens it with its
 * own key, checks the note pays it at least the price, and checks the pool's
 * `transact` event in that transaction created exactly that note. Nobody watching the
 * chain learns who paid whom or how much.
 */
import { sealJson, openJson } from "./box.js";
import { fromB64, toB64, utf8ToB64 } from "./bytes.js";
import { noteMessage, type NoteMessage } from "./board.js";
import type { Identity } from "./keys.js";
import { decodeAddress } from "./keys.js";
import type { HushdNetwork } from "./network.js";
import { makeNote } from "./note.js";
import { txStatus } from "./rpc.js";
import type { PrivateWallet } from "./wallet.js";

export const X402_SCHEME = "hushd";

export interface X402Requirement {
  scheme: typeof X402_SCHEME;
  /** "near-testnet" or "near-mainnet". */
  network: string;
  /** Price in the token's base units. */
  maxAmountRequired: string;
  /** NEP-141 token account id. */
  asset: string;
  /** hushd1… address that receives the payment. */
  payTo: string;
  resource: string;
  description?: string;
  mimeType?: string;
  maxTimeoutSeconds?: number;
  extra?: { pool: string };
}

export interface X402PaymentPayload {
  txHash: string;
  /** The account that sent the transaction (the relayer). */
  sender: string;
  /** Payment note commitment, decimal. */
  commitment: string;
  /** The note's opening, sealed to the payee's key (base64). */
  opening: string;
}

export const x402Network = (net: HushdNetwork) => `near-${net.id}`;

export function paymentRequired(net: HushdNetwork, r: Omit<X402Requirement, "scheme" | "network" | "extra">) {
  return { x402Version: 1, error: "Payment required", accepts: [{ scheme: X402_SCHEME, network: x402Network(net), extra: { pool: net.pool! }, maxTimeoutSeconds: 120, ...r }] };
}

const b64json = (v: unknown) => utf8ToB64(JSON.stringify(v));
const unb64json = <T>(s: string): T => JSON.parse(new TextDecoder().decode(fromB64(s))) as T;

/**
 * Fetch, paying a "hushd" 402 privately when asked. `maxAmount` (base units, per
 * token) caps what a single call may pay; anything above is refused, not paid.
 */
export async function x402Fetch(
  wallet: PrivateWallet,
  url: string,
  init: RequestInit = {},
  opts: { maxAmount: (token: string) => bigint; onPaid?: (p: { token: string; amount: bigint; txHash: string; payTo: string }) => void | Promise<void> },
): Promise<{ response: Response; paid?: { token: string; amount: bigint; txHash: string } }> {
  const first = await fetch(url, init);
  if (first.status !== 402) return { response: first };
  const body = (await first.json().catch(() => null)) as { accepts?: X402Requirement[] } | null;
  const req = body?.accepts?.find((a) => a.scheme === X402_SCHEME && a.network === x402Network(wallet.net));
  if (!req) throw new Error(`${url} asks for payment, but not privately on NEAR ${wallet.net.id}`);
  const amount = BigInt(req.maxAmountRequired);
  if (amount > opts.maxAmount(req.asset)) throw new Error(`${url} asks ${amount} of ${req.asset}, above the limit for one payment`);
  const sent = await wallet.send(req.payTo, req.asset, amount, `x402 ${new URL(req.resource || url).pathname}`.slice(0, 120));
  const payTo = decodeAddress(req.payTo);
  const info = await wallet.relayerInfo();
  const payload: X402PaymentPayload = {
    txHash: sent.txHash,
    sender: info.account,
    commitment: sent.note.commitment.toString(),
    opening: toB64(sealJson(payTo.encPublic, noteMessage(sent.note))),
  };
  await opts.onPaid?.({ token: req.asset, amount, txHash: sent.txHash, payTo: req.payTo });
  const headers = new Headers(init.headers);
  headers.set("X-PAYMENT", b64json({ x402Version: 1, scheme: X402_SCHEME, network: req.network, payload }));
  const response = await fetch(url, { ...init, headers });
  return { response, paid: { token: req.asset, amount, txHash: sent.txHash } };
}

interface TxOutcome {
  status?: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome?: { outcome: { executor_id: string; logs: string[]; status: { SuccessValue?: string; Failure?: unknown } } }[];
}

/** The commitments a pool `transact` event in this transaction created. */
export function transactCommitments(tx: TxOutcome, pool: string): bigint[] {
  const out: bigint[] = [];
  for (const r of tx.receipts_outcome ?? []) {
    if (r.outcome.executor_id !== pool || r.outcome.status.Failure) continue;
    for (const log of r.outcome.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      const ev = JSON.parse(log.slice(11)) as { event: string; data: { commitments?: string[] }[] };
      if (ev.event !== "transact") continue;
      for (const d of ev.data) for (const c of d.commitments ?? []) out.push(BigInt(c));
    }
  }
  return out;
}

/**
 * Server side: check an `X-PAYMENT` header pays `req`. `seen` guards replays (keep it
 * for at least as long as payments are accepted).
 */
export async function verifyX402Payment(
  net: HushdNetwork,
  payee: Identity,
  header: string | null | undefined,
  req: Pick<X402Requirement, "asset" | "maxAmountRequired">,
  seen: { has(c: string): boolean | Promise<boolean>; add(c: string): unknown },
  fetchTx: (hash: string, sender: string) => Promise<unknown> = (h, s) => txStatus(net, h, s),
): Promise<{ ok: true; amount: bigint; txHash: string; commitment: string } | { ok: false; reason: string }> {
  if (!header) return { ok: false, reason: "no X-PAYMENT header" };
  let p: { scheme?: string; network?: string; payload?: X402PaymentPayload };
  try {
    p = unb64json(header);
  } catch {
    return { ok: false, reason: "X-PAYMENT is not base64 JSON" };
  }
  if (p.scheme !== X402_SCHEME || p.network !== x402Network(net) || !p.payload) return { ok: false, reason: "wrong scheme or network" };
  const { txHash, sender, commitment, opening } = p.payload;
  if (await seen.has(commitment)) return { ok: false, reason: "this payment was already used" };
  const msg = openJson<NoteMessage>(payee.encSecret, fromB64(opening));
  if (!msg) return { ok: false, reason: "the note opening is not sealed to this payee" };
  const note = makeNote(payee.pk, msg.token, BigInt(msg.amount), BigInt(msg.blinding));
  if (note.commitment.toString() !== BigInt(commitment).toString()) return { ok: false, reason: "the opening does not match the commitment" };
  if (note.token !== req.asset) return { ok: false, reason: `paid in ${note.token}, not ${req.asset}` };
  if (note.amount < BigInt(req.maxAmountRequired)) return { ok: false, reason: "paid less than the price" };
  const tx = (await fetchTx(txHash, sender).catch(() => null)) as TxOutcome | null;
  if (!tx || tx.status?.SuccessValue === undefined) return { ok: false, reason: "the payment transaction is not final and successful" };
  if (!transactCommitments(tx, net.pool!).some((c) => c === note.commitment)) return { ok: false, reason: "the pool did not create this note in that transaction" };
  await seen.add(commitment);
  return { ok: true, amount: note.amount, txHash, commitment };
}

/** The `X-PAYMENT-RESPONSE` header a server sends back after a good payment. */
export const paymentResponse = (r: { txHash: string; network: string }) => b64json({ success: true, transaction: r.txHash, network: r.network });
