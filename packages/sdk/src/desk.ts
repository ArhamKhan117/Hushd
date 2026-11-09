/**
 * The desk, end to end, for both sides of a deal.
 *
 * Trader: build a package request, seal it to the matcher enclave, commit it on chain
 * through the relayer, send each registered maker the ask (no limit price) sealed to
 * that maker, wait for the enclave's match, then settle.
 *
 * Settlement (the same for both sides, through the API's sealed deal room):
 *   1. each side plans its leg: a note for the other side and its own change
 *   2. each sends the other its two output commitments and the opening of the note
 *      it made for them, and checks the note it gets opens to the agreed amount, token
 *      and its own receive key
 *   3. each proves its leg bound to the deal and all four outputs
 *   4. the maker (always online) submits both legs to `desk.settle` in one call
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { openJson, sealJson } from "./box.js";
import { bytesToHex as bytesHex, fromB64, hexToBytes, toB64 } from "./bytes.js";
import { noteMessage, type NoteMessage } from "./board.js";
import type { Identity } from "./keys.js";
import { decodeAddress } from "./keys.js";
import { TESTNET, type HushdNetwork } from "./network.js";
import { be32, randomField } from "./field.js";
import { makeNote, noteInner, type Note } from "./note.js";
import { swapLeg } from "./pool.js";
import type { JoinsplitArgs } from "./prove.js";
import type { RelayerClient } from "./relayer.js";
import { view } from "./rpc.js";
import type { LegPlan, PrivateWallet } from "./wallet.js";


export interface MakerView {
  name: string;
  enc_key: string;
  quote_url: string;
  style: string;
  bond: string;
  locked: string;
  deals: number;
  slashed: string;
  active: boolean;
  quote_key?: string;
}

export interface DealView {
  id: string;
  rfq_id: string;
  maker: string;
  terms_hash: string;
  class: "atomic_pool" | "bonded_hedge" | "atomic_intents";
  matched_at_ms: string;
  expires_at_ms: string;
  bond: string;
  hedge: null | { asset: number; coin: string; is_buy: boolean; size: string; limit_px: string; deadline_ms: number; testnet: boolean };
  status: "matched" | "settling" | "hedge_pending" | "slashing" | "slash_refused" | "closed";
  settle_attempts: number;
  /** 1 while the opening order is out or filled, 2 once closed. */
  hedge_orders: number;
  /** Opening orders signed so far (at most 3). */
  hedge_attempts: number;
  bond_released: boolean;
  /** Slashed bond the desk still holds for the trader (the pool refused it). */
  slash_held: string;
  attested_by: string;
  receipt: null | { outcome: "settled" | "recovered" | "failed" | "unresolved"; evidence: { kind: string; reference: string }[]; recorded_at_ms: string };
}

export interface DeskConfig {
  owner: string;
  pool: string;
  bond_token: string;
  outlayer: string;
  matcher_project: string;
  secrets_owner: string;
  mpc: string;
  keeper: string;
  outlayer_fee: string;
  min_bond: string;
  /** How long a config change waits; pool, bond token and MPC never change. */
  config_timelock_ns: string;
}

export const deskView = {
  config: (net: HushdNetwork) => view<DeskConfig>(net, net.desk!, "config"),
  pendingConfig: (net: HushdNetwork) => view<{ id: string; change: Omit<DeskConfig, "pool" | "bond_token" | "mpc" | "config_timelock_ns">; apply_after_ns: string } | null>(net, net.desk!, "pending_config"),
  enclave: (net: HushdNetwork) => view<{ sign_key: string | null; enc_key: string | null; project: string }>(net, net.desk!, "enclave"),
  makers: (net: HushdNetwork) => view<[string, MakerView][]>(net, net.desk!, "makers"),
  deal: (net: HushdNetwork, id: number) => view<DealView | null>(net, net.desk!, "deal", { deal_id: String(id) }),
  deals: (net: HushdNetwork, limit = 20) => view<DealView[]>(net, net.desk!, "deals", { from_index: null, limit }),
  stats: (net: HushdNetwork) => view<Record<string, unknown>>(net, net.desk!, "stats"),
};

/** What a maker sees of an RFQ: the pair, the side and the size, never the trader's limit. */
export interface MakerAsk {
  v: 1;
  rfqId: number;
  kind: "spot" | "spot_hedge" | "carry";
  /** The trader sells this (the maker takes it). */
  sell: { token: string; amount: string };
  /** The maker gives this token. */
  buyToken: string;
  hedge?: { coin: string; testnet: boolean };
  closesAtMs: number;
}

export interface AgreedTerms {
  rfqId: number;
  maker: string;
  class: "atomic_pool" | "bonded_hedge" | "atomic_intents";
  traderGives: { token: string; amount: string };
  makerGives: { token: string; amount: string };
  hedge: DealView["hedge"] | null;
  bond: string;
  expiresAtMs: number;
}

/** The API's RFQ intake and deal rooms. */
export class DeskApi {
  constructor(readonly baseUrl: string) {}
  private async req<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `API answered ${res.status}`);
    return json;
  }
  postRfq(rfqId: number, rfqBox: string, makerBoxes: Record<string, string>) {
    return this.req<{ ok: true; closesAtMs: number }>("/v1/rfq", { rfqId, rfqBox, makerBoxes });
  }
  openRfqs(maker: string) {
    return this.req<{ rfqId: number; box: string; closesAtMs: number }[]>(`/v1/rfq/open?maker=${encodeURIComponent(maker)}`);
  }
  postQuote(rfqId: number, maker: string, box: string) {
    return this.req<{ ok: true }>(`/v1/rfq/${rfqId}/quotes`, { maker, box });
  }
  result(rfqId: number) {
    return this.req<{ status: string; closesAtMs: number; quotes: number; dealId?: number | null; matched?: boolean; reason?: string; for_trader?: string; for_maker?: string; txHash?: string }>(`/v1/rfq/${rfqId}/result`);
  }
  send(dealId: number, to: Uint8Array, value: unknown) {
    return this.req<{ id: number }>(`/v1/deals/${dealId}/messages`, { to: bytesHex(to), box: toB64(sealJson(to, value)) });
  }
  async inbox<T>(dealId: number, me: Identity, after = 0): Promise<{ id: number; msg: T }[]> {
    const list = await this.req<{ id: number; box: string }[]>(`/v1/deals/${dealId}/messages?to=${bytesHex(me.encPublic)}&after=${after}`);
    return list.flatMap((m) => {
      const msg = openJson<T>(me.encSecret, fromB64(m.box));
      return msg ? [{ id: m.id, msg }] : [];
    });
  }
}

type RoomMsg =
  | { t: "plan"; outputs: [string, string]; noteForYou: NoteMessage }
  | { t: "leg"; leg: ReturnType<typeof swapLeg>; approval: string };

export type PackageKind = MakerAsk["kind"];

/** What a trader fills in (or the intake drafts): amounts in base units. */
export interface PackageDraft {
  kind: PackageKind;
  sell: { token: string; amount: bigint };
  buy: { token: string; minAmount: bigint };
  /** Hyperliquid coin for spot_hedge and carry (defaults to the bought token's). */
  hedgeCoin?: string;
  /** How long the quote must hold once matched. */
  expiresInMs?: number;
  /** The words the trader typed, sealed to the enclave only. */
  text?: string;
}

/** The per-deal key that alone can close a hedge: derived from the spending key and the refund blinding. */
export function ownerKeyFor(id: Identity, refundBlinding: bigint): { secret: Uint8Array; publicKey: string } {
  const tag = new TextEncoder().encode("hushd.owner.v1");
  const seed = sha256(new Uint8Array([...tag, ...be32(id.sk), ...be32(refundBlinding)]));
  return { secret: seed, publicKey: `ed25519:${base58.encode(ed25519.getPublicKey(seed))}` };
}

/** The message the deal's owner key signs to close its hedge on `net`'s desk. */
export function closeHedgeMessage(net: HushdNetwork, dealId: number): string {
  if (!net.desk) throw new Error(`No desk on ${net.id}`);
  return `hushd.close:${net.desk}:${dealId}`;
}

/**
 * What both parties sign before `desk.settle` takes their legs: "hushd.settle.v1:<desk>:<deal
 * id>:<a0>,<a1>,<b0>,<b1>", the four output commitments (decimal, as the legs carry them),
 * the trader's leg first. The same text as `settle_message` in contracts/desk/src/lib.rs.
 */
export function settleMessage(net: HushdNetwork, dealId: number, outputs: readonly [string, string, string, string]): string {
  if (!net.desk) throw new Error(`No desk on ${net.id}`);
  return `hushd.settle.v1:${net.desk}:${dealId}:${outputs.join(",")}`;
}

/** Sign "hushd.close:<desk>:<deal id>" with the deal's owner key, for `desk.close_hedge`. */
export function closeHedgeSignature(id: Identity, refundBlinding: bigint, dealId: number, net: HushdNetwork = TESTNET): Uint8Array {
  return ed25519.sign(new TextEncoder().encode(closeHedgeMessage(net, dealId)), ownerKeyFor(id, refundBlinding).secret);
}

/**
 * Turn a draft into the sealed request's body (enclave only: it holds the limit) and
 * the ask each maker sees (pair, side and size only). The refund blinding is kept by
 * the caller: a slashed bond pays a note to `noteInner(pk, refundBlinding)`, and the
 * same blinding re-derives the owner key.
 */
export function packageRequest(id: Identity, net: HushdNetwork, d: PackageDraft) {
  if (d.sell.amount <= 0n) throw new Error("Sell a positive amount");
  if (d.sell.token === d.buy.token) throw new Error("Sell and buy different tokens");
  const buy = net.tokens.find((t) => t.id === d.buy.token);
  if (!buy) throw new Error(`Unknown token ${d.buy.token}`);
  const hedged = d.kind !== "spot";
  const coin = d.hedgeCoin ?? buy.hedgeCoin;
  if (hedged && !coin) throw new Error(`${buy.symbol} has no Hyperliquid perp to hedge with`);
  const refundBlinding = randomField();
  const owner = ownerKeyFor(id, refundBlinding);
  const hedge = hedged ? { coin: coin!, testnet: net.id !== "mainnet" } : undefined;
  const request = {
    v: 1,
    kind: d.kind,
    sell: { token: d.sell.token, amount: d.sell.amount.toString() },
    buy: { token: d.buy.token, minAmount: d.buy.minAmount.toString() },
    ...(hedge ? { hedge: { ...hedge, maxSlippageBps: 50 } } : {}),
    expiresInMs: d.expiresInMs ?? 10 * 60_000,
    trader: { address: id.address, refundInner: bytesHex(be32(noteInner(id.pk, refundBlinding))), ownerKey: owner.publicKey },
    ...(d.text ? { text: d.text } : {}),
  };
  const ask: Omit<MakerAsk, "rfqId" | "closesAtMs"> = { v: 1, kind: d.kind, sell: request.sell, buyToken: d.buy.token, ...(hedge ? { hedge } : {}) };
  return { request, ask, refundBlinding };
}

/** How many makers one RFQ asks: the API keeps at most this many sealed asks per request. */
export const MAX_ASKED_MAKERS = 32;

/** Seal the trader's request to the enclave and its ask to each maker, and commit it on chain. */
export async function openRfq(p: {
  net: HushdNetwork;
  api: DeskApi;
  relayer: RelayerClient;
  request: object;
  ask: Omit<MakerAsk, "rfqId" | "closesAtMs">;
  windowMs: number;
}): Promise<{ rfqId: number; closesAtMs: number }> {
  const enclave = await deskView.enclave(p.net);
  if (!enclave.enc_key) throw new Error("The desk has no enclave key yet");
  const rfqBox = sealJson(hexToBytes(enclave.enc_key), p.request);
  const commitment = bytesHex(sha256(rfqBox));
  const { rfqId } = await p.relayer.openRfq(commitment, p.windowMs);
  const closesAtMs = Date.now() + p.windowMs;
  // anyone may register as a maker: ask only active ones with a usable key, the best bonded first, as many as the API takes
  const makers = (await deskView.makers(p.net))
    .filter(([, m]) => m.active && /^0x[0-9a-fA-F]{64}$/.test(m.enc_key))
    .sort(([, a], [, b]) => (BigInt(b.bond) > BigInt(a.bond) ? 1 : BigInt(b.bond) < BigInt(a.bond) ? -1 : 0))
    .slice(0, MAX_ASKED_MAKERS);
  const makerBoxes = Object.fromEntries(makers.map(([acc, m]) => [acc, toB64(sealJson(hexToBytes(m.enc_key), { ...p.ask, v: 1, rfqId, closesAtMs }))]));
  await p.api.postRfq(rfqId, toB64(rfqBox), makerBoxes);
  return { rfqId, closesAtMs };
}

/**
 * Whether a bond is one of the desk's steps: `minBond` times 1, 2 or 5, or ten, a hundred
 * (and so on) times one of those. The desk refuses any other bond (`is_bond_step` in
 * contracts/desk), so a deal's public bond says only which step its size falls in.
 */
export function isBondStep(bond: bigint, minBond: bigint): boolean {
  const unit = minBond > 0n ? minBond : 1n;
  if (bond <= 0n || bond % unit !== 0n) return false;
  let q = bond / unit;
  while (q % 10n === 0n) q /= 10n;
  return q === 1n || q === 2n || q === 5n;
}

/** The smallest bond step at or above `atLeast` (base units of the bond token). */
export function bondStepAtLeast(atLeast: bigint, minBond: bigint): bigint {
  const unit = minBond > 0n ? minBond : 1n;
  for (let scale = unit; ; scale *= 10n) {
    for (const k of [1n, 2n, 5n]) if (k * scale >= atLeast) return k * scale;
  }
}

/**
 * The trader's own check of a match before settling anything: the enclave is trusted to
 * pick the best quote, but never to go below what the trader asked for. Throws in plain
 * words when the terms are not what the draft asked; the deal then simply expires.
 */
export function checkMatchedTerms(terms: AgreedTerms, d: PackageDraft): void {
  if (terms.traderGives.token !== d.sell.token || BigInt(terms.traderGives.amount) !== d.sell.amount) {
    throw new Error("The match asks you to give something other than what you offered; not settling");
  }
  if (terms.makerGives.token !== d.buy.token) throw new Error("The match pays a different token than you asked for; not settling");
  if (BigInt(terms.makerGives.amount) < d.buy.minAmount) throw new Error("The match pays less than the least you accept; not settling");
  const hedged = d.kind !== "spot";
  if (hedged !== Boolean(terms.hedge) || (hedged ? terms.class !== "bonded_hedge" : terms.class !== "atomic_pool")) {
    throw new Error("The match is a different package than you asked for; not settling");
  }
}

/** Wait for the enclave's answer to an RFQ (the matcher runs when the window closes). */
export async function awaitMatch(api: DeskApi, me: Identity, rfqId: number, timeoutMs = 180_000, onTick?: (s: { status: string; quotes: number }) => void) {
  const start = Date.now();
  for (;;) {
    const r = await api.result(rfqId);
    onTick?.({ status: r.status, quotes: r.quotes });
    if (r.status === "matched" && r.dealId != null && r.for_trader) {
      const opened = openJson<{ terms: AgreedTerms; maker_address: string; terms_hash: string }>(me.encSecret, fromB64(r.for_trader));
      if (!opened) throw new Error("The match was not sealed to this identity");
      return { dealId: r.dealId, txHash: r.txHash ?? "", ...opened };
    }
    if (["no_quotes", "no_match", "failed"].includes(r.status)) throw new Error(r.reason ?? `No deal: ${r.status}`);
    if (Date.now() - start > timeoutMs) throw new Error("No answer from the matcher in time");
    await new Promise((res) => setTimeout(res, 1_500));
  }
}

/** Check a note the other side made for you opens to what was agreed. */
export function checkNoteForMe(me: Identity, m: NoteMessage, expected: { token: string; amount: string }, commitment: string): Note {
  const note = makeNote(me.pk, m.token, BigInt(m.amount), BigInt(m.blinding));
  if (m.token !== expected.token || m.amount !== expected.amount) throw new Error("The other side's note is not the agreed amount or token");
  if (note.commitment.toString() !== BigInt(commitment).toString()) throw new Error("The other side's note does not match the output it committed to");
  return note;
}

async function waitFor<T extends RoomMsg>(api: DeskApi, dealId: number, me: Identity, t: T["t"], timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const msgs = await api.inbox<RoomMsg>(dealId, me);
    const hit = msgs.find((m) => m.msg.t === t);
    if (hit) return hit.msg as T;
    if (Date.now() - start > timeoutMs) throw new Error(`The other side did not send its ${t} in time`);
    await new Promise((res) => setTimeout(res, 1_000));
  }
}

export interface SettleProgress {
  (step: "planning" | "waiting_plan" | "proving" | "waiting_settlement" | "settled", detail?: string): void;
}

/**
 * Trader side of settlement (leg A). `refundBlinding` is the one `packageRequest` returned:
 * it re-derives the deal's owner key, which approves the four outputs. Returns the note
 * received from the maker.
 */
export async function settleAsTrader(p: { net: HushdNetwork; api: DeskApi; wallet: PrivateWallet; dealId: number; terms: AgreedTerms; makerAddress: string; refundBlinding: bigint; onStep?: SettleProgress }): Promise<{ received: Note; plan: LegPlan }> {
  const me = p.wallet.id;
  const maker = decodeAddress(p.makerAddress);
  p.onStep?.("planning");
  const plan = await p.wallet.planLeg(BigInt(p.dealId), { token: p.terms.traderGives.token, amount: BigInt(p.terms.traderGives.amount) }, maker);
  try {
    return await traderLeg(p, plan, maker);
  } catch (e) {
    // the notes go back to the balance; any the pool did spend are caught by the next sync
    p.wallet.release(plan);
    throw e;
  }
}

async function traderLeg(p: Parameters<typeof settleAsTrader>[0], plan: LegPlan, maker: ReturnType<typeof decodeAddress>): Promise<{ received: Note; plan: LegPlan }> {
  const me = p.wallet.id;
  const aOut = plan.outputs.map((o) => o.commitment.toString()) as [string, string];
  await p.api.send(p.dealId, maker.encPublic, { t: "plan", outputs: aOut, noteForYou: noteMessage(plan.outputs[0], { dealId: BigInt(p.dealId) }) } satisfies RoomMsg);
  p.onStep?.("waiting_plan");
  const theirs = await waitFor<Extract<RoomMsg, { t: "plan" }>>(p.api, p.dealId, me, "plan", 120_000);
  const received = checkNoteForMe(me, theirs.noteForYou, p.terms.makerGives, theirs.outputs[0]);
  // the note for me checked out: approve exactly these four outputs with the deal's owner key
  const message = new TextEncoder().encode(settleMessage(p.net, p.dealId, [...aOut, ...theirs.outputs]));
  const approval = toB64(ed25519.sign(message, ownerKeyFor(me, p.refundBlinding).secret));
  p.onStep?.("proving");
  const legA: JoinsplitArgs = await p.wallet.proveLeg(plan, aOut.map(BigInt) as [bigint, bigint], theirs.outputs.map(BigInt) as [bigint, bigint]);
  await p.api.send(p.dealId, maker.encPublic, { t: "leg", leg: swapLeg(legA), approval } satisfies RoomMsg);
  p.onStep?.("waiting_settlement");
  const start = Date.now();
  for (;;) {
    const d = await deskView.deal(p.net, p.dealId);
    // "settling" is the pool call in flight; a refused one goes back to "matched"
    if (d?.status === "closed" && d.receipt?.outcome === "failed") throw new Error("The deal expired before it settled");
    if (d && d.status !== "matched" && d.status !== "settling") break;
    if (Date.now() - start > 180_000) throw new Error("The deal did not settle in time");
    await new Promise((res) => setTimeout(res, 2_000));
  }
  await p.wallet.settled(plan, received);
  p.onStep?.("settled");
  return { received, plan };
}

/**
 * Maker side of settlement (leg B): answers the trader's plan, then submits both legs with
 * both approvals; `quoteSecret` is the maker's quote key, the one its consents are signed with.
 */
export async function settleAsMaker(p: { net: HushdNetwork; api: DeskApi; relayer: RelayerClient; wallet: PrivateWallet; dealId: number; terms: AgreedTerms; traderAddress: string; quoteSecret: Uint8Array }): Promise<{ txHash: string; received: Note }> {
  const me = p.wallet.id;
  const trader = decodeAddress(p.traderAddress);
  const theirs = await waitFor<Extract<RoomMsg, { t: "plan" }>>(p.api, p.dealId, me, "plan", 120_000);
  const received = checkNoteForMe(me, theirs.noteForYou, p.terms.traderGives, theirs.outputs[0]);
  const plan = await p.wallet.planLeg(BigInt(p.dealId), { token: p.terms.makerGives.token, amount: BigInt(p.terms.makerGives.amount) }, trader);
  try {
    return await makerLeg(p, plan, theirs, received, trader);
  } catch (e) {
    p.wallet.release(plan);
    throw e;
  }
}

async function makerLeg(
  p: Parameters<typeof settleAsMaker>[0],
  plan: LegPlan,
  theirs: Extract<RoomMsg, { t: "plan" }>,
  received: Note,
  trader: ReturnType<typeof decodeAddress>,
): Promise<{ txHash: string; received: Note }> {
  const me = p.wallet.id;
  const bOut = plan.outputs.map((o) => o.commitment.toString()) as [string, string];
  await p.api.send(p.dealId, trader.encPublic, { t: "plan", outputs: bOut, noteForYou: noteMessage(plan.outputs[0], { dealId: BigInt(p.dealId) }) } satisfies RoomMsg);
  const legB = await p.wallet.proveLeg(plan, theirs.outputs.map(BigInt) as [bigint, bigint], bOut.map(BigInt) as [bigint, bigint]);
  const legA = await waitFor<Extract<RoomMsg, { t: "leg" }>>(p.api, p.dealId, me, "leg", 180_000);
  // the trader's leg must carry the outputs whose note this maker checked
  if (legA.leg.commitments.some((c, i) => c !== theirs.outputs[i])) throw new Error(`Deal ${p.dealId}: the trader's leg names other outputs than its plan`);
  const message = new TextEncoder().encode(settleMessage(p.net, p.dealId, [...theirs.outputs, ...bOut]));
  const approvals = { trader: legA.approval, maker: toB64(ed25519.sign(message, p.quoteSecret)) };
  const r = await p.relayer.settle(p.dealId, [legA.leg, swapLeg(legB)], approvals);
  await p.wallet.settled(plan, received, r.txHash);
  return { txHash: r.txHash, received };
}
