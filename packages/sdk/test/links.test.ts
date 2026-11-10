/**
 * Claim links: the code, and the claim itself against an in-memory pool, board and relayer
 * (behind a stubbed fetch), with real joinsplit proofs checked by the circuit's verifying key.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import { openNote } from "../src/board.ts";
import { be32, concat, R } from "../src/field.ts";
import { identityFromSeed } from "../src/keys.ts";
import {
  ALREADY_CLAIMED,
  checkLink,
  claimLink,
  decodeLink,
  encodeLink,
  LinkError,
  linkIdentity,
  linkNote,
  linkUrl,
  newLink,
  NOT_IN_POOL,
  parseLink,
  payAsLink,
  removeUnsentLink,
  sentLinks,
  takeBackLink,
  type Link,
} from "../src/links.ts";
import { makeNote } from "../src/note.ts";
import type { TransactRequest } from "../src/pool.ts";
import { loadPoseidon } from "../src/poseidon.ts";
import { RelayerError, type RelayerClient } from "../src/relayer.ts";
import type { WalletState } from "../src/wallet.ts";
import { artifacts, Chain, NET, relayerFor, TOKEN, useChain, walletOf } from "./chain.ts";

before(loadPoseidon);
after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

/** A wallet with `amount` of TOKEN already in the pool. */
async function funded(chain: Chain, seedByte: number, amount: bigint, relayer: RelayerClient, saved?: WalletState[]) {
  const id = identityFromSeed(new Uint8Array(32).fill(seedByte));
  const note = makeNote(id.pk, TOKEN, amount);
  chain.insert(note.commitment);
  const w = walletOf(id, relayer, saved);
  w.track(note);
  await w.sync();
  assert.equal(w.balances().get(TOKEN), amount);
  return w;
}

/** Re-encode a link's bytes after `edit`, with a valid check, to reach the field checks. */
function recode(code: string, edit: (b: Uint8Array) => Uint8Array): string {
  const body = edit(base64urlnopad.decode(code).slice(0, -4));
  return base64urlnopad.encode(concat(body, sha256(concat(new TextEncoder().encode("hushd.link"), body)).slice(0, 4)));
}

test("a link code round-trips, in a whole URL or alone, and is URL-safe", () => {
  const link = newLink(TOKEN, 25_000_000n);
  const code = encodeLink(link);
  assert.match(code, /^[A-Za-z0-9_-]+$/);
  assert.equal(base64urlnopad.decode(code)[0], 1, "the version byte comes first");
  assert.deepEqual(decodeLink(code), link);
  const url = linkUrl("https://hushd.net/", link);
  assert.equal(url, `https://hushd.net/app/claim#${code}`);
  assert.deepEqual(parseLink(`  ${url}\n`), link);
  // the largest amount a note holds, and a 64-character implicit account as the token
  const big: Link = { seed: new Uint8Array(32).fill(9), token: "a".repeat(64), amount: (1n << 128n) - 1n, blinding: R - 1n };
  assert.deepEqual(decodeLink(encodeLink(big)), big);
  assert.notEqual(encodeLink(newLink(TOKEN, 25_000_000n)), code, "every link has its own seed");
  assert.throws(() => newLink(TOKEN, 0n), RangeError);
  assert.throws(() => newLink("Not A Token!", 1n), RangeError);
});

test("malformed link codes are refused in words a person can act on", () => {
  const code = encodeLink(newLink(TOKEN, 25_000_000n));
  const incomplete = /not a complete Hushd claim link/;
  for (const bad of ["", "hello", "####", code.slice(0, -1), code.slice(0, -6), `${code}A`, code.slice(1), `${code.slice(0, 40)}${code[40] === "A" ? "B" : "A"}${code.slice(41)}`, code.replace(/./g, (c, i) => (i === 10 ? "+" : c))]) {
    assert.throws(() => decodeLink(bad), (e: Error) => e instanceof LinkError && incomplete.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => decodeLink(recode(code, (b) => Uint8Array.of(2, ...b.slice(1)))), /newer version of Hushd/);
  const amountAt = 1 + 32 + 32;
  // an amount of zero bytes, a zero-padded amount, more than 16 amount bytes
  assert.throws(() => decodeLink(recode(code, (b) => concat(b.slice(0, amountAt), Uint8Array.of(0), b.slice(amountAt + 1 + b[amountAt]!)))), incomplete);
  assert.throws(() => decodeLink(recode(code, (b) => concat(b.slice(0, amountAt), Uint8Array.of(b[amountAt]! + 1, 0), b.slice(amountAt + 1)))), incomplete);
  assert.throws(() => decodeLink(recode(code, (b) => concat(b.slice(0, amountAt), Uint8Array.of(17), new Uint8Array(17).fill(1), b.slice(amountAt + 1 + b[amountAt]!)))), incomplete);
  // a blinding outside the field, a token that is no account id, a byte left over
  assert.throws(() => decodeLink(recode(code, (b) => concat(b.slice(0, 33), be32(R), b.slice(65)))), incomplete);
  assert.throws(() => decodeLink(recode(code, (b) => b.map((x, i) => (i === b.length - 1 ? 0x21 : x)))), incomplete);
  assert.throws(() => decodeLink(recode(code, (b) => concat(b, Uint8Array.of(0)))), incomplete);
});

test("a claim spends the link note into a note only the claimer owns", async () => {
  const chain = useChain();
  const sends: TransactRequest[] = [];
  const saved: WalletState[] = [];
  let savedBeforeSend = false;
  const { relayer } = relayerFor(chain, {
    onTransact: (r) => {
      sends.push(r);
      // the payer's store holds the link before the payment into it goes out
      if (sends.length === 1) savedBeforeSend = saved.at(-1)?.links?.length === 1;
    },
  });
  const alice = await funded(chain, 21, 100_000_000n, relayer, saved);
  const paid = await payAsLink(alice, TOKEN, 25_000_000n);
  assert.ok(savedBeforeSend, "the link was saved before the payment was sent");
  assert.equal(saved.at(-1)!.links![0]!.txHash, paid.txHash);
  const link = paid.link;
  const lid = linkIdentity(link);
  assert.ok(!chain.posts.some((p) => openNote(lid, p)), "nothing about the link is posted to the board");
  await alice.sync();
  assert.equal(alice.balances().get(TOKEN), 75_000_000n);
  assert.deepEqual((await sentLinks(alice)).map((l) => l.state), ["waiting"]);

  // the visitor checks the link against the pool before seeing any amount
  const check = await checkLink(NET, parseLink(linkUrl("https://hushd.net", link)));
  assert.equal(check.state, "ready");

  const bob = walletOf(identityFromSeed(new Uint8Array(32).fill(22)), relayer);
  const r = await claimLink(link, { to: bob, artifacts, relayer, ...(check.state === "ready" ? { tree: check.tree } : {}) });
  const claim = sends.at(-1)!;
  assert.equal(BigInt(claim.args.nullifiers[0]), linkNote(link).nullifier, "the claim spends the link note");
  assert.equal(BigInt(claim.args.commitments[0]), r.note.commitment);
  assert.equal(claim.args.public_amount, "0", "nothing leaves the pool");
  assert.equal(r.note.pk, bob.id.pk);
  assert.equal(r.note.amount, 25_000_000n);
  assert.equal(r.note.token, TOKEN);
  // it shows at once, as landing, then as balance
  assert.ok(bob.pending().some((n) => n.commitment === r.note.commitment));
  await bob.sync();
  assert.equal(bob.balances().get(TOKEN), 25_000_000n);

  // word of it is on the board for the claimer only: the seed alone recovers it on a new device
  const word = chain.posts.at(-1)!;
  assert.equal(openNote(alice.id, word), null);
  assert.equal(openNote(lid, word), null);
  assert.equal(openNote(bob.id, word)?.commitment, r.note.commitment);
  const bobAgain = walletOf(bob.id, relayer);
  await bobAgain.sync();
  assert.equal(bobAgain.balances().get(TOKEN), 25_000_000n);

  // the payer sees it claimed and cannot take it back; a second claim gets the one neutral answer
  assert.deepEqual((await sentLinks(alice)).map((l) => l.state), ["claimed"]);
  assert.equal((await checkLink(NET, link)).state, "claimed");
  await assert.rejects(takeBackLink(alice, link, { artifacts, relayer }), (e: Error) => e.message === ALREADY_CLAIMED);
  const carol = walletOf(identityFromSeed(new Uint8Array(32).fill(23)), relayer);
  await assert.rejects(claimLink(link, { to: carol, artifacts, relayer }), (e: Error) => e.message === ALREADY_CLAIMED);
  assert.equal(alice.balances().get(TOKEN), 75_000_000n);
});

test("an unclaimed link is taken back, and a claim after that gets the same answer as any spent link", async () => {
  const chain = useChain();
  const { relayer } = relayerFor(chain);
  const alice = await funded(chain, 31, 40_000_000n, relayer);
  const { link } = await payAsLink(alice, TOKEN, 40_000_000n);
  await alice.sync();
  assert.equal(alice.balances().get(TOKEN) ?? 0n, 0n);
  await takeBackLink(alice, link, { artifacts, relayer });
  await alice.sync();
  assert.equal(alice.balances().get(TOKEN), 40_000_000n);
  assert.deepEqual((await sentLinks(alice)).map((l) => l.state), ["taken back"]);
  const bob = walletOf(identityFromSeed(new Uint8Array(32).fill(32)), relayer);
  await assert.rejects(claimLink(link, { to: bob, artifacts, relayer }), (e: Error) => e.message === ALREADY_CLAIMED);
});

test("a take back interrupted after it was sent still reads as taken back", async () => {
  const chain = useChain();
  const { relayer } = relayerFor(chain);
  const saved: WalletState[] = [];
  const alice = await funded(chain, 41, 10_000_000n, relayer, saved);
  const { link } = await payAsLink(alice, TOKEN, 10_000_000n);
  // only the claim's own record: the take back's final write never happened
  const lost = walletOf(alice.id, relayer);
  await claimLink(link, { to: lost, artifacts, relayer, beforeSend: (p) => alice.rememberLink({ ...alice.links()[0]!, takeBack: p.blinding.toString() }) });
  const restarted = walletOf(alice.id, relayer, saved);
  await restarted.restore();
  assert.deepEqual((await sentLinks(restarted)).map((l) => l.state), ["taken back"]);
});

test("a link the relayer refuses is not kept; one whose send is in doubt is kept until the pool shows it", async () => {
  const chain = useChain();
  const refused = relayerFor(chain, { refuse: new RelayerError("The relayer's daily budget is used up; try again tomorrow", 400) });
  const alice = await funded(chain, 51, 10_000_000n, refused.relayer);
  await assert.rejects(payAsLink(alice, TOKEN, 5_000_000n), /daily budget/);
  assert.equal(alice.links().length, 0);

  const doubtful = relayerFor(chain, { refuse: new RelayerError("relayer answered 502", 502) });
  const bob = await funded(chain, 52, 10_000_000n, doubtful.relayer);
  await assert.rejects(payAsLink(bob, TOKEN, 5_000_000n));
  assert.equal(bob.links().length, 1);
  assert.deepEqual((await sentLinks(bob)).map((l) => l.state), ["sending"]);
  // ten minutes on, a synced wallet that never saw its note says it was not sent, and may drop it
  await bob.sync();
  const later = Date.now() + 11 * 60_000;
  const [stuck] = await sentLinks(bob, later);
  assert.equal(stuck!.state, "not sent");
  await removeUnsentLink(bob, stuck!.link);
  assert.equal(bob.links().length, 0);
});

test("a link whose payment is not in the pool says so, and one for a token the network does not list is refused", async () => {
  useChain();
  const link = newLink(TOKEN, 1_000_000n);
  assert.equal((await checkLink(NET, link)).state, "missing");
  // a symbol is not a token id: only the exact account id the pool knows will do
  await assert.rejects(checkLink(NET, { ...link, token: "usdc" }), /does not list on NEAR testnet/);
  const { relayer } = relayerFor(new Chain());
  const bob = walletOf(identityFromSeed(new Uint8Array(32).fill(61)), relayer);
  await assert.rejects(claimLink(link, { to: bob, artifacts, relayer }), (e: Error) => e.message === NOT_IN_POOL);
});

test("a wallet restored on page load pays before its first sync, and overlapping syncs keep one copy of each leaf", async () => {
  const chain = useChain();
  const { relayer } = relayerFor(chain);
  const saved: WalletState[] = [];
  const before = await funded(chain, 71, 30_000_000n, relayer, saved);
  // a new page: notes come back from the store with their leaf positions, the tree comes back empty
  const restored = walletOf(before.id, relayer, saved);
  await restored.restore();
  assert.equal(restored.merkleTree.size, 0);
  await payAsLink(restored, TOKEN, 10_000_000n);
  // the session's timer and a payment can sync at once: the tree must not take the same leaves twice
  await Promise.all([restored.sync(), restored.sync(), restored.sync()]);
  assert.equal(restored.merkleTree.size, chain.tree.size);
  assert.equal(restored.merkleTree.root(), chain.tree.root());
  assert.equal(restored.balances().get(TOKEN), 20_000_000n);
});
