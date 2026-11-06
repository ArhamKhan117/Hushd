/** Keys, addresses, sealed boxes and a real joinsplit proof made by the SDK. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import * as snarkjs from "snarkjs";
import { openJson, sealJson } from "../src/box.ts";
import { closeHedgeMessage, closeHedgeSignature, ownerKeyFor } from "../src/desk.ts";
import { extHash } from "../src/field.ts";
import { decodeAddress, identityFromSeed, isAddress } from "../src/keys.ts";
import { TESTNET, withOverrides } from "../src/network.ts";
import { makeNote, own } from "../src/note.ts";
import { loadPoseidon } from "../src/poseidon.ts";
import { proveJoinsplit, type ArtifactSource } from "../src/prove.ts";
import { MerkleTree } from "../src/tree.ts";

const circuits = join(import.meta.dirname, "../../../app/public/circuits");
const src: ArtifactSource = { wasm: (n) => join(circuits, `${n}.wasm`), zkey: (n) => join(circuits, `${n}.zkey`) };

before(loadPoseidon);
// snarkjs keeps its curve worker threads alive; end them so the run can finish.
after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

test("an identity is stable for a seed and its address round-trips", () => {
  const a = identityFromSeed(new Uint8Array(32).fill(1));
  const b = identityFromSeed(new Uint8Array(32).fill(1));
  assert.equal(a.address, b.address);
  assert.ok(a.address.startsWith("hushd1"));
  const back = decodeAddress(a.address);
  assert.equal(back.pk, a.pk);
  assert.deepEqual(back.encPublic, a.encPublic);
  assert.ok(!isAddress("hushd1qqqq"));
  assert.notEqual(identityFromSeed(new Uint8Array(32).fill(2)).address, a.address);
});

test("a hedge close is signed for one desk and one deal", () => {
  const id = identityFromSeed(new Uint8Array(32).fill(4));
  const owner = base58.decode(ownerKeyFor(id, 77n).publicKey.slice("ed25519:".length));
  const sig = closeHedgeSignature(id, 77n, 12);
  assert.equal(closeHedgeMessage(TESTNET, 12), "hushd.close:desk.hushd.testnet:12");
  assert.ok(ed25519.verify(sig, new TextEncoder().encode("hushd.close:desk.hushd.testnet:12"), owner));
  const other = withOverrides(TESTNET, { desk: "desk.sandbox" });
  assert.ok(!ed25519.verify(sig, new TextEncoder().encode(closeHedgeMessage(other, 12)), owner));
  assert.ok(ed25519.verify(closeHedgeSignature(id, 77n, 12, other), new TextEncoder().encode("hushd.close:desk.sandbox:12"), owner));
});

test("a sealed box opens only for its recipient", () => {
  const alice = identityFromSeed(new Uint8Array(32).fill(3));
  const bob = identityFromSeed(new Uint8Array(32).fill(4));
  const box = sealJson(alice.encPublic, { amount: "5" });
  assert.deepEqual(openJson(alice.encSecret, box), { amount: "5" });
  assert.equal(openJson(bob.encSecret, box), null);
  box[60] ^= 1;
  assert.equal(openJson(alice.encSecret, box), null);
});

test("the SDK proves a private send the circuit's key accepts", async () => {
  const me = identityFromSeed(new Uint8Array(32).fill(5));
  const bob = identityFromSeed(new Uint8Array(32).fill(6));
  const token = "usdc.sandbox";
  const mine = own(makeNote(me.pk, token, 100n), me);
  const tree = new MerkleTree([123n, mine.commitment]);
  const out = await proveJoinsplit(src, me, tree, {
    inputs: [{ ...mine, leafIndex: 1 }],
    outputs: [makeNote(bob.pk, token, 70n), makeNote(me.pk, token, 30n)],
    ext: {},
  });
  const vkey = JSON.parse(readFileSync(join(circuits, "joinsplit.vkey.json"), "utf8"));
  assert.ok(await snarkjs.groth16.verify(vkey, out.publicSignals, out.proof));
  assert.equal(out.publicSignals[0], tree.root().toString());
  assert.equal(out.publicSignals[7], extHash().toString());
});

test("an unbalanced plan is refused before proving", async () => {
  const me = identityFromSeed(new Uint8Array(32).fill(5));
  const mine = own(makeNote(me.pk, "usdc.sandbox", 10n), me);
  await assert.rejects(
    proveJoinsplit(src, me, new MerkleTree([mine.commitment]), { inputs: [mine], outputs: [makeNote(me.pk, "usdc.sandbox", 11n), makeNote(me.pk, "usdc.sandbox", 0n)] }),
    /do not balance/,
  );
});

test("intake encryption round-trips through the model's key", async () => {
  const { encryptForModel, decryptFromModel, clientKey } = await import("../src/intake.ts");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  // stand in for the model: its ed25519 key, used the way the TEE uses it
  const model = clientKey();
  const wire = encryptForModel("sell 50K NEAR for BTC", model.publicHex);
  assert.equal(decryptFromModel(wire, model.x25519Secret), "sell 50K NEAR for BTC");
  assert.ok(ed25519.getPublicKey(model.secret).length === 32);
});

test("a trader refuses a match below its limit, in the wrong token or of the wrong package", async () => {
  const { checkMatchedTerms } = await import("../src/desk.ts");
  const draft = { kind: "spot" as const, sell: { token: "usdc.hushd.testnet", amount: 1_000_000_000n }, buy: { token: "btc.hushd.testnet", minAmount: 1_300_000n } };
  const terms = {
    rfqId: 1,
    maker: "maker-a.hushd.testnet",
    class: "atomic_pool" as const,
    traderGives: { token: "usdc.hushd.testnet", amount: "1000000000" },
    makerGives: { token: "btc.hushd.testnet", amount: "1310000" },
    hedge: null,
    bond: "0",
    expiresAtMs: 0,
  };
  checkMatchedTerms(terms, draft);
  assert.throws(() => checkMatchedTerms({ ...terms, makerGives: { ...terms.makerGives, amount: "1299999" } }, draft), /less than the least/);
  assert.throws(() => checkMatchedTerms({ ...terms, makerGives: { token: "wnear.hushd.testnet", amount: "1310000" } }, draft), /different token/);
  assert.throws(() => checkMatchedTerms({ ...terms, traderGives: { ...terms.traderGives, amount: "1000000001" } }, draft), /other than what you offered/);
  assert.throws(() => checkMatchedTerms({ ...terms, class: "bonded_hedge" }, draft), /different package/);
});
