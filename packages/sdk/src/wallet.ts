/**
 * A private wallet: the notes one identity owns, kept in sync with the pool and the
 * board, and the moves you make with them (send privately, cash out, swap legs).
 *
 * Every note this wallet creates for itself (change, a shield, a refund note) is also
 * posted to the board encrypted to its own key, so the seed alone recovers the wallet
 * on a new device.
 *
 * A desk deal pays the trader at a one-time deal identity (`dealIdentityFor`): the wallet
 * keeps that note's opening in its store from the moment it checks out, and moves it into
 * its own balance once the deal settles (`moveDealNote`), trying again on every sync until
 * the move lands.
 */
import { sealNote } from "./board.js";
import { scanBoard } from "./board.js";
import { dealIdentityFor, deskView } from "./desk.js";
import { randomField, swapExtHash, type ExtData } from "./field.js";
import type { Identity, ReceiveAddress } from "./keys.js";
import { decodeAddress } from "./keys.js";
import type { HushdNetwork } from "./network.js";
import { makeNote, own, type Note } from "./note.js";
import { loadTree, poolView, shieldCall, transactRequest } from "./pool.js";
import { proveJoinsplit, type ArtifactSource, type JoinsplitArgs } from "./prove.js";
import { screenAddresses } from "./screening.js";
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

/** A claim link this wallet paid (links.ts), kept only in its own encrypted store. */
export interface StoredLink {
  /** The link's one-time seed, hex. It is the link: whoever holds it can claim the payment. */
  seed: string;
  token: string;
  amount: string;
  /** The link note's blinding. */
  blinding: string;
  atMs: number;
  /** The payment into the link, once the relayer sent it. */
  txHash?: string;
  /** Blinding of the note a take back makes for this wallet, kept before it is sent. */
  takeBack?: string;
  /** How it ended, once the pool shows the link note spent. */
  ended?: "claimed" | "taken back";
}

/**
 * A note a maker paid to one deal's one-time identity, kept until this wallet moved it into
 * its own balance. Its opening is saved before the trader's leg goes out, so a settlement
 * that lands while this device is gone is still found and moved.
 */
export interface StoredDealNote {
  dealId: string;
  /** Re-derives the deal identity that owns the note (`dealIdentityFor`). */
  refundBlinding: string;
  token: string;
  amount: string;
  blinding: string;
  atMs: number;
  /** Blinding of the note the move makes for this wallet, kept before the move is sent. */
  moveBlinding?: string;
  /** The private send that moved it, once the relayer sent it. */
  movedTx?: string;
  /** "moved": the note is in this wallet's balance; "unsettled": the deal expired unsettled, so it never existed. */
  ended?: "moved" | "unsettled";
}

/** Where a deal's note stands: moved into the balance, not in the pool yet, or never made (the deal expired). */
export type DealNoteMove = { state: "moved"; txHash?: string } | { state: "waiting"; reason?: string } | { state: "unsettled" };

export interface WalletState {
  notes: StoredNote[];
  boardCursor: number;
  payments?: StoredPayment[];
  /** Notes that may land later without a board post (a bond paid to you if a maker defaults). */
  expected?: StoredNote[];
  deals?: DealRecord[];
  links?: StoredLink[];
  dealNotes?: StoredDealNote[];
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

export interface PayOptions {
  /** Seal word of the note to its owner on the board, so their wallet finds it (leave out when they learn of it another way). */
  word?: { to: ReceiveAddress; memo?: string };
  /** The hushd1… address paid, kept with the payment record. */
  to?: string;
  /** Runs once the payment is proven, just before it goes out: keep here whatever must survive a crash mid-send. */
  beforeSend?: () => Promise<void>;
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
  /** Notes chosen for a leg in flight (by commitment): nothing else may pick them until it settles or is released. */
  private held = new Set<bigint>();
  private tree = new MerkleTree();
  /** The tree load in flight: loads add leaves to one tree in place, so they run one at a time. */
  private treeLoad: Promise<void> | null = null;
  private boardCursor = 0;
  private paid: StoredPayment[] = [];
  private expected: StoredNote[] = [];
  private dealLog: DealRecord[] = [];
  private linkLog: StoredLink[] = [];
  private dealNoteLog: StoredDealNote[] = [];
  /** Moves in flight, by deal id: a sync and a settlement never move one note twice at once. */
  private moving = new Map<string, Promise<DealNoteMove>>();

  constructor(
    readonly net: HushdNetwork,
    readonly id: Identity,
    /** `tree`: a tree already loaded from the pool, to sync on from. */
    private readonly opts: { artifacts: ArtifactSource; relayer?: RelayerClient; store?: NoteStore; tree?: MerkleTree },
  ) {
    if (opts.tree) this.tree = opts.tree;
  }

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
    this.linkLog = s.links ?? [];
    this.dealNoteLog = s.dealNotes ?? [];
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
      links: this.linkLog,
      dealNotes: this.dealNoteLog,
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

  /**
   * Pull new leaves and board posts, place notes in the tree, mark spent ones, then move any
   * deal's note that landed into this wallet. `board: false` skips the board, for a wallet
   * that already knows its notes (a claim link's); `moves: false` skips the moves.
   */
  async sync(opts: { board?: boolean; moves?: boolean } = {}): Promise<void> {
    await this.refreshTree();
    if (this.net.board && opts.board !== false) {
      const { notes, next } = await scanBoard(this.net, this.id, this.boardCursor);
      for (const n of notes) if (n && n.amount > 0n && !this.notes.has(n.commitment)) this.notes.set(n.commitment, n);
      this.boardCursor = next;
    }
    this.expected = this.expected.filter((e) => {
      const note = own(makeNote(this.id.pk, e.token, BigInt(e.amount), BigInt(e.blinding)), this.id);
      const i = this.tree.indexOf(note.commitment);
      if (i < 0) return true;
      const kept = this.notes.get(note.commitment);
      if (kept) kept.leafIndex ??= i;
      else this.notes.set(note.commitment, { ...note, leafIndex: i, ...(e.memo ? { memo: e.memo } : {}), ...(e.dealId ? { dealId: e.dealId } : {}) });
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
    if (opts.moves !== false) await this.moveDealNotes();
  }

  /** Pull the pool's new leaves into the tree, after any load already in flight. */
  private async refreshTree(): Promise<void> {
    while (this.treeLoad) await this.treeLoad.catch(() => undefined);
    const load = (async () => {
      this.tree = await loadTree(this.net, 500, this.tree);
    })();
    this.treeLoad = load;
    try {
      await load;
    } finally {
      if (this.treeLoad === load) this.treeLoad = null;
    }
  }

  /**
   * A restored wallet knows where its notes sit before its tree is loaded again (a page load
   * empties it): load the tree up to the notes about to be spent before proving.
   */
  private async treeHolding(notes: Note[]): Promise<void> {
    const held = () => notes.every((n) => n.leafIndex === undefined || this.tree.leaf(n.leafIndex) === n.commitment);
    if (!held()) await this.refreshTree();
    if (!held()) throw new Error("a note to spend is not in the pool's tree");
  }

  /** Spendable notes (in the tree, not spent, not held for a leg in flight). */
  spendable(token?: string): Note[] {
    return [...this.notes.values()].filter((n) => !n.spent && n.leafIndex !== undefined && !this.held.has(n.commitment) && (!token || n.token === token));
  }

  /**
   * What legs in flight are holding, by token. A held note a sync already saw spent still
   * counts: its leg's change comes back once that leg records its settlement.
   */
  private heldTotal(token: string): bigint {
    return [...this.notes.values()].filter((n) => this.held.has(n.commitment) && n.token === token).reduce((s, n) => s + n.amount, 0n);
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
    await this.treeHolding(notes);
    // output 0 is what the pool reads as a payment: a merge pays no one, so it is a zero note
    const j = await proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs: notes, outputs: [makeNote(this.id.pk, token, 0n), merged] });
    const r = await this.relayer().transact(transactRequest(j, 0n, null));
    await this.afterSpend(notes, [merged]);
    return r.txHash;
  }

  private async ensureCovered(token: string, amount: bigint): Promise<Note[]> {
    // a leg in flight may be holding the notes this needs: its change frees up when it settles
    const deadline = Date.now() + 4 * 60_000;
    while (Date.now() < deadline) {
      const picked = this.select(token, amount);
      if (picked) return picked;
      const total = this.spendable(token).reduce((s, n) => s + n.amount, 0n);
      if (total < amount) {
        // change from a payment a moment ago is still landing, or held by a leg in flight: wait rather than refuse
        const landing = this.pending().filter((n) => n.token === token).reduce((s, n) => s + n.amount, 0n);
        if (total + landing + this.heldTotal(token) < amount) throw new Error("not enough in your private balance");
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
    // a retried move expects the same note again
    if (this.expected.some((e) => e.token === note.token && e.amount === note.amount.toString() && e.blinding === note.blinding.toString())) return;
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

  /** Remember (or update) a claim link this wallet paid, by its seed, in its encrypted store. */
  async rememberLink(l: StoredLink): Promise<void> {
    const i = this.linkLog.findIndex((x) => x.seed === l.seed);
    if (i >= 0) this.linkLog[i] = l;
    else this.linkLog.unshift(l);
    await this.persist();
  }

  async forgetLink(seed: string): Promise<void> {
    this.linkLog = this.linkLog.filter((x) => x.seed !== seed);
    await this.persist();
  }

  /** Claim links this wallet paid, newest first. */
  links(): StoredLink[] {
    return this.linkLog.map((l) => ({ ...l }));
  }

  /** Remember (or update) the note a deal paid to its one-time identity, by deal id. */
  async rememberDealNote(n: StoredDealNote): Promise<void> {
    const i = this.dealNoteLog.findIndex((x) => x.dealId === n.dealId);
    if (i >= 0) this.dealNoteLog[i] = n;
    else this.dealNoteLog.unshift(n);
    await this.persist();
  }

  /** Notes deals paid to their one-time identities, newest first; those not `ended` are still on their way into the balance. */
  dealNotes(): StoredDealNote[] {
    return this.dealNoteLog.map((n) => ({ ...n }));
  }

  /**
   * Move the note deal `dealId` paid to its one-time identity into this wallet: a throwaway
   * wallet for the deal identity spends it into a note for this wallet's receive key, through
   * the relayer (no gas, no fee), the way a claim link is claimed. The new note's blinding is
   * made here and kept, with the note expected, before the move goes out. Waits up to
   * `waitMs` for the note to show in the pool, and tries a failed move again within that
   * time; past it, a failure is `waiting` with its `reason`. Safe to call again: a note
   * already spent was moved (only this wallet's key spends it), and one move per deal runs
   * at a time (a call during another joins it, then goes on waiting if it has longer).
   */
  async moveDealNote(dealId: number, o: { waitMs?: number } = {}): Promise<DealNoteMove> {
    const key = String(dealId);
    const deadline = Date.now() + (o.waitMs ?? 0);
    for (;;) {
      let run = this.moving.get(key);
      if (!run) {
        const started = this.moveOnce(key, deadline).finally(() => {
          if (this.moving.get(key) === started) this.moving.delete(key);
        });
        this.moving.set(key, started);
        run = started;
      }
      let out: DealNoteMove;
      try {
        out = await run;
      } catch (e) {
        out = { state: "waiting", reason: (e as Error).message ?? String(e) };
      }
      if (out.state !== "waiting" || Date.now() >= deadline) return out;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  /** Try every deal note not moved yet; one that fails or has not landed stays on record for the next try. */
  async moveDealNotes(): Promise<DealNoteMove[]> {
    if (!this.opts.relayer) return [];
    const open = this.dealNoteLog.filter((n) => !n.ended && !this.moving.has(n.dealId));
    const out: DealNoteMove[] = [];
    for (const n of open) out.push(await this.moveDealNote(Number(n.dealId)));
    return out;
  }

  private async moveOnce(key: string, deadline: number): Promise<DealNoteMove> {
    for (;;) {
      const rec = this.dealNoteLog.find((x) => x.dealId === key);
      if (!rec) throw new Error(`This wallet has no note from deal ${key}`);
      if (rec.ended === "moved") return { state: "moved", ...(rec.movedTx ? { txHash: rec.movedTx } : {}) };
      if (rec.ended === "unsettled") return { state: "unsettled" };
      const deal = dealIdentityFor(this.id, BigInt(rec.refundBlinding));
      const note = own(makeNote(deal.pk, rec.token, BigInt(rec.amount), BigInt(rec.blinding)), deal);
      await this.refreshTree();
      if (this.tree.indexOf(note.commitment) >= 0) return this.moveLanded(rec, deal, note);
      // not in the pool: the deal is still settling, or expired and never made it
      const d = await deskView.deal(this.net, Number(key)).catch(() => undefined);
      if (d?.status === "closed" && d.receipt?.outcome === "failed") {
        await this.rememberDealNote({ ...rec, ended: "unsettled" });
        return { state: "unsettled" };
      }
      if (Date.now() >= deadline) return { state: "waiting" };
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  private async moveLanded(rec: StoredDealNote, deal: Identity, note: Note): Promise<DealNoteMove> {
    const moved = async (txHash?: string): Promise<DealNoteMove> => {
      const latest = this.dealNoteLog.find((x) => x.dealId === rec.dealId) ?? rec;
      await this.rememberDealNote({ ...latest, ...(txHash ? { movedTx: txHash } : {}), ended: "moved" });
      return { state: "moved", ...((txHash ?? latest.movedTx) ? { txHash: txHash ?? latest.movedTx } : {}) };
    };
    // its own copy of the tree: this wallet's tree only ever grows under its own loads
    const w = new PrivateWallet(this.net, deal, { artifacts: this.opts.artifacts, relayer: this.relayer(), tree: this.tree.clone() });
    w.track(note);
    // the deal record carries the note's opening: no board scan
    await w.sync({ board: false });
    if (w.spendable(rec.token).length === 0) return moved();
    // the same blinding on every try: a retry makes the very note an earlier try may have sent
    const blinding = rec.moveBlinding ? BigInt(rec.moveBlinding) : randomField();
    const payment = makeNote(this.id.pk, rec.token, BigInt(rec.amount), blinding);
    const memo = `From deal #${rec.dealId}`;
    let r: SendResult;
    try {
      r = await w.pay(payment, {
        word: { to: this.id, memo },
        beforeSend: async () => {
          // on record before the move goes out: if it lands while this device is gone, a sync still finds it
          await this.rememberDealNote({ ...rec, moveBlinding: blinding.toString() });
          await this.expect(payment, { memo, dealId: rec.dealId });
        },
      });
    } catch (e) {
      // an earlier try reached the pool first
      if (/already spent/i.test((e as Error).message)) return moved();
      throw e;
    }
    this.track(payment);
    const kept = this.notes.get(payment.commitment);
    if (kept) Object.assign(kept, { memo, dealId: rec.dealId });
    return moved(r.txHash);
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
    return this.pay(makeNote(dest.pk, token, amount), { word: { to: dest, ...(memo ? { memo } : {}) }, ...(typeof to === "string" ? { to } : {}) });
  }

  /** Pay a note made beforehand (`makeNote` for its owner's receive key) privately, through the relayer. */
  async pay(payment: Note, opts: PayOptions = {}): Promise<SendResult> {
    const inputs = await this.ensureCovered(payment.token, payment.amount);
    const have = inputs.reduce((s, n) => s + n.amount, 0n);
    const change = makeNote(this.id.pk, payment.token, have - payment.amount);
    await this.treeHolding(inputs);
    // the payment goes first: the pool's receipt and volume checks count only output 0
    const j = await proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs, outputs: [payment, change] });
    await opts.beforeSend?.();
    // the change is on record before the send, so a send that lands as the tab closes still finds it
    await this.expect(change);
    const r = await this.relayer().transact(transactRequest(j, 0n, null));
    if (opts.word) await this.relayer().post(sealNote(opts.word.to, payment, opts.word.memo ? { memo: opts.word.memo } : {}), "note");
    this.record("send", payment, inputs[0]!, { to: opts.to, txHash: r.txHash });
    await this.afterSpend(inputs, [change]);
    return { txHash: r.txHash, note: payment };
  }

  /** Cash out to a NEAR account. A refund note comes back to you if the payout cannot be paid. */
  async cashOut(recipient: string, token: string, amount: bigint, fee = 0n): Promise<{ txHash: string }> {
    // the recipient is public: screened before anything is proven (the relayer checks again)
    const screen = screenAddresses([recipient]);
    if (!screen.allowed) throw new Error(screen.message);
    const inputs = await this.ensureCovered(token, amount);
    const have = inputs.reduce((s, n) => s + n.amount, 0n);
    const change = makeNote(this.id.pk, token, have - amount);
    const refund = makeNote(this.id.pk, token, amount - fee);
    const info = await this.relayer().info();
    const ext: ExtData = { recipient, relayer: info.account, fee, refundInner: refund.inner };
    await this.treeHolding(inputs);
    // the cash out leaves the pool publicly; output 0, read as a payment, is a zero note so change never passes for one
    const j = await proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs, outputs: [makeNote(this.id.pk, token, 0n), change], publicAmount: amount, ext });
    // the refund note only exists if the payout fails; posting it to self keeps it recoverable either way
    await this.relayer().post(sealNote(this.id, refund, { memo: "refund if the cash out could not be paid" }), "note");
    await this.expect(change);
    const r = await this.relayer().transact(transactRequest(j, amount, token, ext));
    this.track(refund);
    await this.afterSpend(inputs, [change]);
    return { txHash: r.txHash };
  }

  /** Step 1 of a swap leg: choose inputs and make your two outputs (the counterparty's note first, then your change). */
  async planLeg(dealId: bigint, give: { token: string; amount: bigint }, counterparty: string | ReceiveAddress): Promise<LegPlan> {
    const dest = typeof counterparty === "string" ? decodeAddress(counterparty) : counterparty;
    const inputs = await this.ensureCovered(give.token, give.amount);
    // held until the deal settles or the leg is released, so a second deal cannot spend them too
    for (const n of inputs) this.held.add(n.commitment);
    const have = inputs.reduce((s, n) => s + n.amount, 0n);
    const change = makeNote(this.id.pk, give.token, have - give.amount);
    // if the pool settles this leg after this side gave up waiting, the change is still found
    await this.expect(change, { dealId: dealId.toString() });
    return { dealId, inputs, outputs: [makeNote(dest.pk, give.token, give.amount), change] };
  }

  /**
   * A leg that will not settle (expired, refused): its notes are free again. If the pool did
   * spend them after all, the next sync marks them spent and finds the change planLeg expects.
   */
  release(plan: LegPlan): void {
    for (const n of plan.inputs) this.held.delete(n.commitment);
  }

  /** Step 2: prove your leg bound to both sides' outputs (leg A is the trader's, B the maker's). */
  async proveLeg(plan: LegPlan, aOutputs: [bigint, bigint], bOutputs: [bigint, bigint]): Promise<JoinsplitArgs> {
    const binding = swapExtHash(plan.dealId, aOutputs, bOutputs);
    await this.treeHolding(plan.inputs);
    return proveJoinsplit(this.opts.artifacts, this.id, this.tree, { inputs: plan.inputs, outputs: plan.outputs, binding });
  }

  /** After the deal settles: your inputs are spent, your change and the counterparty's note to you are yours. */
  async settled(plan: LegPlan, received?: Note, txHash?: string): Promise<void> {
    this.record("deal", plan.outputs[0], plan.inputs[0]!, { dealId: plan.dealId.toString(), ...(txHash ? { txHash } : {}) });
    await this.afterSpend(plan.inputs, [plan.outputs[1]]);
    this.release(plan);
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
