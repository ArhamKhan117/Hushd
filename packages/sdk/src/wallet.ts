/**
 * A private wallet: the notes one identity owns, kept in sync with the pool and the
 * board, and the moves you make with them (send privately, cash out, swap legs).
 *
 * Every note this wallet creates for itself (change, a shield, a refund note) is also
 * posted to the board encrypted to its own key, so the seed alone recovers the wallet
 * on a new device.
 */
import { sealNote } from "./board.js";
import { scanBoard } from "./board.js";
import { swapExtHash, type ExtData } from "./field.js";
import type { Identity, ReceiveAddress } from "./keys.js";
import { decodeAddress } from "./keys.js";
import type { HushdNetwork } from "./network.js";
import { makeNote, own, type Note } from "./note.js";
import { loadTree, poolView, shieldCall, transactRequest } from "./pool.js";
import { proveJoinsplit, type ArtifactSource, type JoinsplitArgs } from "./prove.js";
import type { RelayerClient } from "./relayer.js";
import { MerkleTree } from "./tree.js";

export interface StoredNote {
  token: string;
  amount: string;
  blinding: string;
  leafIndex?: number;
  spent?: boolean;
  memo?: string;
  dealId?: string;
}

/** A payment this wallet made: the note it created for someone and a note it spent to pay it. */
export interface StoredPayment {
  kind: "send" | "deal";
  token: string;
  made: { pk: string; amount: string; blinding: string };
  paidWith: { amount: string; blinding: string };
  dealId?: string;
  to?: string;
  txHash?: string;
  atMs: number;
}

/** A payment with its notes rebuilt, ready for a receipt or volume proof. */
export interface Payment {
  kind: "send" | "deal";
  token: string;
  made: Note;
  paidWith: Note;
  dealId?: string;
  to?: string;
  txHash?: string;
  atMs: number;
}

/** A desk deal this wallet took part in, kept only in its own encrypted store. */
export interface DealRecord {
  dealId: number;
  rfqId: number;
  role: "trader" | "maker";
  kind: "spot" | "spot_hedge" | "carry";
  maker: string;
  class: string;
  gave: { token: string; amount: string };
  got: { token: string; amount: string };
  bond: string;
  /** Re-derives the deal's owner key (closing a hedge) and the slashed-bond note. */
  refundBlinding?: string;
  atMs: number;
  settledAtMs?: number;
}

export interface WalletState {
  notes: StoredNote[];
  boardCursor: number;
  payments?: StoredPayment[];
  /** Notes that may land later without a board post (a bond paid to you if a maker defaults). */
  expected?: StoredNote[];
  deals?: DealRecord[];
}

/** Where notes are kept between sessions (memory, an encrypted browser store, a file). */
export interface NoteStore {
  load(): Promise<WalletState | null>;
  save(state: WalletState): Promise<void>;
}

export class MemoryStore implements NoteStore {
  private state: WalletState | null = null;
  async load() {
    return this.state;
  }
  async save(s: WalletState) {
    this.state = structuredClone(s);
  }
}

export interface SendResult {
  txHash: string;
  /** The note made for the recipient. */
  note: Note;
}

/** Your half of a swap before proving: your two outputs, so both sides can bind all four. */
export interface LegPlan {
  dealId: bigint;
  inputs: Note[];
  /** [note for the counterparty, your change] */
  outputs: [Note, Note];
}

export class PrivateWallet {
  private notes = new Map<bigint, Note & { spent?: boolean; memo?: string; dealId?: string }>();
  private tree = new MerkleTree();
  private boardCursor = 0;
  private paid: StoredPayment[] = [];
  private expected: StoredNote[] = [];
  private dealLog: DealRecord[] = [];

  constructor(
    readonly net: HushdNetwork,
    readonly id: Identity,
    private readonly opts: { artifacts: ArtifactSource; relayer?: RelayerClient; store?: NoteStore },
  ) {}

  get address(): string {
    return this.id.address;
  }

  async restore(): Promise<void> {
    const s = await this.opts.store?.load();
    if (!s) return;
    this.boardCursor = s.boardCursor;
    this.paid = s.payments ?? [];
    this.expected = s.expected ?? [];
    this.dealLog = s.deals ?? [];
    for (const n of s.notes) {
      const note = own(makeNote(this.id.pk, n.token, BigInt(n.amount), BigInt(n.blinding)), this.id);
      this.notes.set(note.commitment, { ...note, ...(n.leafIndex !== undefined ? { leafIndex: n.leafIndex } : {}), spent: n.spent, memo: n.memo, dealId: n.dealId });
    }
  }

  private async persist(): Promise<void> {
    await this.opts.store?.save({
      boardCursor: this.boardCursor,
      payments: this.paid,
      expected: this.expected,
      deals: this.dealLog,
      notes: [...this.notes.values()].map((n) => ({
        token: n.token,
        amount: n.amount.toString(),
        blinding: n.blinding.toString(),
        ...(n.leafIndex !== undefined ? { leafIndex: n.leafIndex } : {}),
        ...(n.spent ? { spent: true } : {}),
        ...(n.memo ? { memo: n.memo } : {}),
        ...(n.dealId ? { dealId: n.dealId } : {}),
      })),
    });
  }

  /** Remember a note this wallet made for itself (before or after it lands). */
  track(note: Note): void {
    if (note.pk !== this.id.pk || note.amount === 0n) return;
    const owned = own(note, this.id);
    if (!this.notes.has(owned.commitment)) this.notes.set(owned.commitment, owned);
  }

  /** Pull new leaves and board posts, place notes in the tree, mark spent ones. */
  async sync(): Promise<void> {
    this.tree = await loadTree(this.net, 500, this.tree);
    if (this.net.board) {
      const { notes, next } = await scanBoard(this.net, this.id, this.boardCursor);
      for (const n of notes) if (n && n.amount > 0n && !this.notes.has(n.commitment)) this.notes.set(n.commitment, n);
      this.boardCursor = next;
    }
    this.expected = this.expected.filter((e) => {
      const note = own(makeNote(this.id.pk, e.token, BigInt(e.amount), BigInt(e.blinding)), this.id);
      const i = this.tree.indexOf(note.commitment);
      if (i < 0) return true;
      this.notes.set(note.commitment, { ...note, leafIndex: i, ...(e.memo ? { memo: e.memo } : {}), ...(e.dealId ? { dealId: e.dealId } : {}) });
      return false;
    });
    for (const n of this.notes.values()) {
      if (n.leafIndex === undefined) {
        const i = this.tree.indexOf(n.commitment);
        if (i >= 0) n.leafIndex = i;
      }
    }
    await Promise.all(
      [...this.notes.values()]
        .filter((n) => !n.spent && n.leafIndex !== undefined)
        .map(async (n) => {
          if (await poolView.isSpent(this.net, n.nullifier!)) n.spent = true;
        }),
    );
    await this.persist();
  }

  /** Spendable notes (in the tree, not spent). */
  spendable(token?: string): Note[] {
    return [...this.notes.values()].filter((n) => !n.spent && n.leafIndex !== undefined && (!token || n.token === token));
  }

  balances(): Map<string, bigint> {
    const out = new Map<string, bigint>();
    for (const n of this.spendable()) out.set(n.token, (out.get(n.token) ?? 0n) + n.amount);
    return out;
  }

  /** Notes waiting for their leaf (a shield or a payment still landing). */
  pending(): Note[] {
    return [...this.notes.values()].filter((n) => !n.spent && n.leafIndex === undefined);
  }

  /** Pick at most two notes covering `amount`, or null when more are needed. */
  select(token: string, amount: bigint): Note[] | null {
    const notes = this.spendable(token).sort((a, b) => (a.amount < b.amount ? -1 : 1));
    const one = notes.find((n) => n.amount >= amount);
    if (one) return [one];
    const top = notes.slice(-2);
    if (top.length === 2 && top[0]!.amount + top[1]!.amount >= amount) return top;
    return null;
  }

  /** A note for a deposit, the `ft_transfer_call` to send, and the self-post that makes it recoverable. */
  shield(token: string, amount: bigint) {
    const note = makeNote(this.id.pk, token, amount);
    this.track(note);
    return { note, call: shieldCall(this.net, note), selfPost: sealNote(this.id, note) };
  }

  private relayer(): RelayerClient {
    if (!this.opts.relayer) throw new Error("this wallet has no relayer");
    return this.opts.relayer;
  }

  relayerInfo() {
    return this.relayer().info();
  }

  /** Merge the two largest notes of a token into one (when a payment needs more than two). */
  async consolidate(token: string): Promise<string> {
    const notes = this.spendable(token).sort((a, b) => (a.amount < b.amount ? 1 : -1)).slice(0, 2);
    if (notes.length < 2) throw new Error("nothing to merge");
    const merged = makeNote(this.id.pk, token, notes[0]!.amount + notes[1]!.amount);
    const j = await proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs: notes, outputs: [merged, makeNote(this.id.pk, token, 0n)] });
    const r = await this.relayer().transact(transactRequest(j, 0n, null));
    await this.afterSpend(notes, [merged]);
    return r.txHash;
  }

  private async ensureCovered(token: string, amount: bigint): Promise<Note[]> {
    for (let i = 0; i < 12; i++) {
      const picked = this.select(token, amount);
      if (picked) return picked;
      const total = this.spendable(token).reduce((s, n) => s + n.amount, 0n);
      if (total < amount) {
        // change from a payment a moment ago is still landing: wait for it rather than refuse
        const landing = this.pending().filter((n) => n.token === token).reduce((s, n) => s + n.amount, 0n);
        if (total + landing < amount) throw new Error("not enough in your private balance");
        await new Promise((r) => setTimeout(r, 2_500));
        await this.sync();
        continue;
      }
      await this.consolidate(token);
      await this.sync();
    }
    throw new Error("your notes are still landing in the pool; try again in a moment");
  }

  /** Mark inputs spent, track own outputs and post them to self for recovery. */
  private async afterSpend(inputs: Note[], ownOutputs: Note[]): Promise<void> {
    for (const n of inputs) {
      const s = this.notes.get(n.commitment);
      if (s) s.spent = true;
    }
    for (const o of ownOutputs) {
      if (o.amount === 0n) continue;
      this.track(o);
      await this.relayer().post(sealNote(this.id, o), "note");
    }
    await this.persist();
  }

  private record(kind: StoredPayment["kind"], made: Note, paidWith: Note, extra: { dealId?: string; to?: string; txHash?: string } = {}) {
    this.paid.unshift({
      kind,
      token: made.token,
      made: { pk: made.pk.toString(), amount: made.amount.toString(), blinding: made.blinding.toString() },
      paidWith: { amount: paidWith.amount.toString(), blinding: paidWith.blinding.toString() },
      ...extra,
      atMs: Date.now(),
    });
  }

  /** Watch for a note that has no board post (it becomes spendable if it ever lands in the pool). */
  async expect(note: Note, extra: { memo?: string; dealId?: string } = {}): Promise<void> {
    if (note.pk !== this.id.pk || note.amount === 0n) return;
    this.expected.push({ token: note.token, amount: note.amount.toString(), blinding: note.blinding.toString(), ...extra });
    await this.persist();
  }

  /** Remember (or update) a desk deal in this wallet's encrypted store. */
  async rememberDeal(d: DealRecord): Promise<void> {
    this.dealLog = [d, ...this.dealLog.filter((x) => x.dealId !== d.dealId)];
    await this.persist();
  }

  deals(): DealRecord[] {
    return [...this.dealLog];
  }

  /** Payments this wallet made, newest first (private sends and desk deal legs). */
  payments(): Payment[] {
    return this.paid.map((p) => ({
      kind: p.kind,
      token: p.token,
      made: makeNote(BigInt(p.made.pk), p.token, BigInt(p.made.amount), BigInt(p.made.blinding)),
      paidWith: own(makeNote(this.id.pk, p.token, BigInt(p.paidWith.amount), BigInt(p.paidWith.blinding)), this.id),
      ...(p.dealId ? { dealId: p.dealId } : {}),
      ...(p.to ? { to: p.to } : {}),
      ...(p.txHash ? { txHash: p.txHash } : {}),
      atMs: p.atMs,
    }));
  }

  /** Pay `amount` of `token` privately to a hushd1… address. */
  async send(to: string | ReceiveAddress, token: string, amount: bigint, memo?: string): Promise<SendResult> {
    const dest = typeof to === "string" ? decodeAddress(to) : to;
    const inputs = await this.ensureCovered(token, amount);
    const have = inputs.reduce((s, n) => s + n.amount, 0n);
    const payment = makeNote(dest.pk, token, amount);
    const change = makeNote(this.id.pk, token, have - amount);
    // the payment goes first: the pool's receipt and volume checks count only output 0
    const j = await proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs, outputs: [payment, change] });
    const r = await this.relayer().transact(transactRequest(j, 0n, null));
    await this.relayer().post(sealNote(dest, payment, memo ? { memo } : {}), "note");
    this.record("send", payment, inputs[0]!, { to: typeof to === "string" ? to : undefined, txHash: r.txHash });
    await this.afterSpend(inputs, [change]);
    return { txHash: r.txHash, note: payment };
  }

  /** Cash out to a NEAR account. A refund note comes back to you if the payout cannot be paid. */
  async cashOut(recipient: string, token: string, amount: bigint, fee = 0n): Promise<{ txHash: string }> {
    const inputs = await this.ensureCovered(token, amount);
    const have = inputs.reduce((s, n) => s + n.amount, 0n);
    const change = makeNote(this.id.pk, token, have - amount);
    const refund = makeNote(this.id.pk, token, amount - fee);
    const info = await this.relayer().info();
    const ext: ExtData = { recipient, relayer: info.account, fee, refundInner: refund.inner };
    const j = await proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs, outputs: [change, makeNote(this.id.pk, token, 0n)], publicAmount: amount, ext });
    // the refund note only exists if the payout fails; posting it to self keeps it recoverable either way
    await this.relayer().post(sealNote(this.id, refund, { memo: "refund if the cash out could not be paid" }), "note");
    const r = await this.relayer().transact(transactRequest(j, amount, token, ext));
    this.track(refund);
    await this.afterSpend(inputs, [change]);
    return { txHash: r.txHash };
  }

  /** Step 1 of a swap leg: choose inputs and make your two outputs (the counterparty's note first, then your change). */
  async planLeg(dealId: bigint, give: { token: string; amount: bigint }, counterparty: string | ReceiveAddress): Promise<LegPlan> {
    const dest = typeof counterparty === "string" ? decodeAddress(counterparty) : counterparty;
    const inputs = await this.ensureCovered(give.token, give.amount);
    const have = inputs.reduce((s, n) => s + n.amount, 0n);
    return { dealId, inputs, outputs: [makeNote(dest.pk, give.token, give.amount), makeNote(this.id.pk, give.token, have - give.amount)] };
  }

  /** Step 2: prove your leg bound to both sides' outputs (leg A is the trader's, B the maker's). */
  async proveLeg(plan: LegPlan, aOutputs: [bigint, bigint], bOutputs: [bigint, bigint]): Promise<JoinsplitArgs> {
    const binding = swapExtHash(plan.dealId, aOutputs, bOutputs);
    return proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs: plan.inputs, outputs: plan.outputs, binding });
  }

  /** After the deal settles: your inputs are spent, your change and the counterparty's note to you are yours. */
  async settled(plan: LegPlan, received?: Note, txHash?: string): Promise<void> {
    this.record("deal", plan.outputs[0], plan.inputs[0]!, { dealId: plan.dealId.toString(), ...(txHash ? { txHash } : {}) });
    await this.afterSpend(plan.inputs, [plan.outputs[1]]);
    if (received) {
      this.track(received);
      const kept = this.notes.get(received.commitment);
      if (kept) kept.dealId = plan.dealId.toString();
      await this.persist();
    }
  }

  get merkleTree(): MerkleTree {
    return this.tree;
  }
}
