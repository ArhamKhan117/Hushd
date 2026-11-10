/**
 * A deal's one-time receive identity, and the move of the note a maker paid to it into the
 * trader's own wallet, against an in-memory pool, board, desk and relayer with real proofs.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openNote } from "../src/board.ts";
import { dealIdentityFor, ownerKeyFor, packageRequest, roomKeyFor } from "../src/desk.ts";
import { be32 } from "../src/field.ts";
import { bytesToHex } from "../src/bytes.ts";
import { decodeAddress, identityFromSeed } from "../src/keys.ts";
import { makeNote, noteInner, own, type Note } from "../src/note.ts";
import type { TransactRequest } from "../src/pool.ts";
import { loadPoseidon } from "../src/poseidon.ts";
import type { RelayerClient } from "../src/relayer.ts";
import type { WalletState } from "../src/wallet.ts";
import { Chain, NET, relayerFor, TOKEN, useChain, walletOf } from "./chain.ts";

before(loadPoseidon);
after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

const settled = (id: number) => ({ id: String(id), status: "closed", receipt: { outcome: "settled", evidence: [], recorded_at_ms: "1" } });

test("each deal receives at its own identity, found again from the seed and the refund blinding", () => {
  const id = identityFromSeed(new Uint8Array(32).fill(7));
  const deal = dealIdentityFor(id, 77n);
  assert.deepEqual(dealIdentityFor(identityFromSeed(new Uint8Array(32).fill(7)), 77n), deal, "the same seed and blinding find it again");
  assert.notEqual(dealIdentityFor(id, 78n).address, deal.address, "another deal, another identity");
  assert.notEqual(dealIdentityFor(identityFromSeed(new Uint8Array(32).fill(8)), 77n).address, deal.address);
  assert.notEqual(deal.address, id.address);
  assert.notEqual(deal.pk, id.pk);
  assert.notDeepEqual(deal.encPublic, id.encPublic);
  // its own domain: not the deal's room key nor its owner key
  assert.notDeepEqual(deal.encSecret, roomKeyFor(id, 77n).encSecret);
  assert.notDeepEqual(deal.encSecret, ownerKeyFor(id, 77n).secret);

  const draft = { kind: "spot" as const, sell: { token: TOKEN, amount: 1_000_000n }, buy: { token: "btc.hushd.testnet", minAmount: 1n } };
  const a = packageRequest(id, NET, draft);
  const b = packageRequest(id, NET, draft);
  assert.equal(a.request.trader.address, a.dealIdentity.address, "the request names the deal identity");
  assert.deepEqual(dealIdentityFor(id, a.refundBlinding), a.dealIdentity);
  assert.notEqual(a.request.trader.address, id.address, "never the wallet's own address");
  assert.notEqual(a.request.trader.address, b.request.trader.address, "two requests, two unrelated addresses");
  // a slashed bond still pays the wallet's own receive key
  assert.equal(a.request.trader.refundInner, bytesToHex(be32(noteInner(id.pk, a.refundBlinding))));
});

/** A trader whose deal `dealId` settled: the maker's note to the deal identity is in the pool and on record. */
async function settledDeal(chain: Chain, relayer: RelayerClient, seedByte: number, dealId: number, amount: bigint, saved: WalletState[] = []) {
  const trader = walletOf(identityFromSeed(new Uint8Array(32).fill(seedByte)), relayer, saved);
  const refundBlinding = 1000n + BigInt(dealId);
  const deal = dealIdentityFor(trader.id, refundBlinding);
  // the maker pays the address the request named, which is all it knows of the trader
  const paid = makeNote(decodeAddress(deal.address).pk, TOKEN, amount);
  await trader.rememberDealNote({ dealId: String(dealId), refundBlinding: refundBlinding.toString(), token: TOKEN, amount: amount.toString(), blinding: paid.blinding.toString(), atMs: Date.now() });
  chain.insert(paid.commitment);
  chain.deals.set(dealId, settled(dealId));
  return { trader, deal, paid: own(paid, deal) };
}

const moveOf = (sends: TransactRequest[], paid: Note) => sends.find((r) => r.args.nullifiers.some((n) => BigInt(n) === paid.nullifier));

test("a settled deal's note moves into the trader's own balance through the relayer", async () => {
  const chain = useChain();
  const saved: WalletState[] = [];
  const sends: TransactRequest[] = [];
  let onRecord = false;
  const { relayer } = relayerFor(chain, {
    onTransact: (r) => {
      sends.push(r);
      // the new note's blinding and its expected entry are kept before the move goes out
      const s = saved.at(-1)!;
      const mb = s.dealNotes?.[0]?.moveBlinding;
      onRecord = mb !== undefined && (s.expected ?? []).some((e) => e.blinding === mb && e.amount === "25000000");
    },
  });
  const { trader, deal, paid } = await settledDeal(chain, relayer, 41, 5, 25_000_000n, saved);
  assert.equal(trader.balances().get(TOKEN) ?? 0n, 0n, "nothing in the balance before the move");

  const moved = await trader.moveDealNote(5);
  assert.equal(moved.state, "moved");
  assert.ok(onRecord, "the move was on record before it was sent");
  const move = moveOf(sends, paid)!;
  assert.ok(move, "the move spends the note the maker paid");
  assert.equal(move.args.public_amount, "0", "nothing leaves the pool");
  const rec = trader.dealNotes()[0]!;
  assert.equal(rec.ended, "moved");
  assert.equal(rec.movedTx, moved.state === "moved" ? moved.txHash : undefined);
  const made = makeNote(trader.id.pk, TOKEN, 25_000_000n, BigInt(rec.moveBlinding!));
  assert.equal(BigInt(move.args.commitments[0]), made.commitment, "the new note is the trader's own, with the blinding it made");

  await trader.sync();
  assert.equal(trader.balances().get(TOKEN), 25_000_000n);
  assert.equal(trader.spendable(TOKEN)[0]!.dealId, "5");

  // word of it is on the board for the trader only: the seed alone recovers the balance on a new device
  const word = chain.posts.at(-1)!;
  assert.equal(openNote(trader.id, word)?.commitment, made.commitment);
  assert.equal(openNote(deal, word), null);
  const elsewhere = walletOf(trader.id, relayer);
  await elsewhere.sync();
  assert.equal(elsewhere.balances().get(TOKEN), 25_000_000n);

  // asking again sends nothing
  const count = sends.length;
  assert.equal((await trader.moveDealNote(5)).state, "moved");
  await trader.sync();
  assert.equal(sends.length, count);
});

test("a note the tab closed on is moved by the next sync, and a move that landed unrecorded is found", async () => {
  const chain = useChain();
  const { relayer } = relayerFor(chain);
  // the deal settled while the page was gone: a restored wallet moves the note on its first sync
  const saved: WalletState[] = [];
  const first = await settledDeal(chain, relayer, 51, 8, 4_000_000n, saved);
  const restored = walletOf(first.trader.id, relayer, saved);
  await restored.restore();
  await restored.sync();
  assert.equal(restored.dealNotes()[0]!.ended, "moved");
  await restored.sync();
  assert.equal(restored.balances().get(TOKEN), 4_000_000n);

  // the move went out but the device died before writing it down: the next sync sees the note spent
  const kept: WalletState[] = [];
  const second = await settledDeal(chain, relayer, 52, 9, 6_000_000n, kept);
  let cut = -1;
  const { relayer: watching } = relayerFor(chain, { onTransact: () => void (cut = kept.length) });
  const mover = walletOf(second.trader.id, watching, kept);
  await mover.restore();
  assert.equal((await mover.moveDealNote(9)).state, "moved");
  const crashed = walletOf(second.trader.id, relayer, kept.slice(0, cut));
  await crashed.restore();
  assert.equal(crashed.dealNotes()[0]!.ended, undefined, "the record from just before the send");
  await crashed.sync();
  assert.equal(crashed.dealNotes()[0]!.ended, "moved");
  await crashed.sync();
  assert.equal(crashed.balances().get(TOKEN), 6_000_000n);
});

test("a deal still settling waits, and one that expired unsettled is let go", async () => {
  const chain = useChain();
  const { relayer, seen } = relayerFor(chain);
  const trader = walletOf(identityFromSeed(new Uint8Array(32).fill(61)), relayer);
  await trader.rememberDealNote({ dealId: "11", refundBlinding: "11", token: TOKEN, amount: "1000", blinding: "12345", atMs: Date.now() });
  chain.deals.set(11, { id: "11", status: "settling", receipt: null });
  assert.deepEqual(await trader.moveDealNote(11), { state: "waiting" });
  await trader.sync();
  assert.equal(trader.dealNotes()[0]!.ended, undefined, "kept for the next try");
  chain.deals.set(11, { id: "11", status: "closed", receipt: { outcome: "failed", evidence: [], recorded_at_ms: "1" } });
  assert.deepEqual(await trader.moveDealNote(11), { state: "unsettled" });
  assert.equal(trader.dealNotes()[0]!.ended, "unsettled");
  assert.equal(seen.length, 0, "nothing was sent");
});

test("a trader waiting on its settlement moves the note as soon as it lands, even when a sync tried first", async () => {
  const chain = useChain();
  const { relayer } = relayerFor(chain);
  const trader = walletOf(identityFromSeed(new Uint8Array(32).fill(71)), relayer);
  const deal = dealIdentityFor(trader.id, 21n);
  const paid = makeNote(deal.pk, TOKEN, 3_000_000n);
  await trader.rememberDealNote({ dealId: "21", refundBlinding: "21", token: TOKEN, amount: "3000000", blinding: paid.blinding.toString(), atMs: Date.now() });
  chain.deals.set(21, { id: "21", status: "settling", receipt: null });
  // a sync's quick try is in flight when the trader starts waiting; the deal settles a moment later
  const quick = trader.sync();
  const waiting = trader.moveDealNote(21, { waitMs: 30_000 });
  await quick;
  setTimeout(() => {
    chain.insert(paid.commitment);
    chain.deals.set(21, settled(21));
  }, 1_500);
  const r = await waiting;
  assert.equal(r.state, "moved");
  await trader.sync();
  assert.equal(trader.balances().get(TOKEN), 3_000_000n);
});
