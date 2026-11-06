/** NEAR Intents: the bytes the verifier checks, nonces and the fee arithmetic of a direct trade. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58, base64 } from "@scure/base";
import { implicitAccount, intentNonce, intentsFee, mt, nep413Hash, signIntents, timestampedRandom, tradeDiffs } from "../src/intents.ts";

const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

test("NEP-413 hash matches the verifier repo's own test vector", () => {
  // crates/signatures/nep413 in github.com/near/intents: "Hello, world!", zero nonce, intents.near
  const pub = hex("e2e9cb7ac57cb46d4da1ce1d1cc2c33bdfe17407c517916b522724a8ea2c6c50");
  const sig = hex("e2ff6254871a3fec1853c167b42f0f14248c4cf7fef5452dc24d8dbdc5c4bf183ab707322b4d782d5f5a05571bae476c5f7ee41c473f3002e600865e46b75d0f");
  assert.ok(ed25519.verify(sig, nep413Hash("Hello, world!", new Uint8Array(32), "intents.near"), pub));
});

test("a versioned nonce carries the salt and the deadline in ns", () => {
  const random = new Uint8Array(15).fill(7);
  const n = intentNonce("252812b3", 1_800_000_000_123, random);
  assert.equal(n.length, 32);
  assert.equal(Buffer.from(n.subarray(0, 9)).toString("hex"), "5628f6c600252812b3");
  assert.equal(new DataView(n.buffer).getBigInt64(9, true), 1_800_000_000_123_000_000n);
  assert.deepEqual(n.subarray(17), random);
  assert.throws(() => intentNonce("xyz", 1, random));
});

test("timestamped random bytes start with the signing time, as 1Click's sign-in expects", () => {
  const r = timestampedRandom(1_800_000_000_000);
  assert.equal(r.length, 15);
  assert.equal(new DataView(r.buffer).getBigInt64(0, true), 1_800_000_000_000_000_000n);
});

test("signed intents verify, name the implicit signer and use one deadline for message and nonce", () => {
  const secret = new Uint8Array(32).fill(1);
  const signer = implicitAccount(secret);
  const deadlineMs = 1_800_000_000_000;
  const p = signIntents({ signerId: signer, secret, verifier: "intents.near", salt: "252812b3", deadlineMs, intents: [{ intent: "token_diff", diff: { [mt("wrap.near")]: "-5" } }] });
  const msg = JSON.parse(p.payload.message);
  assert.deepEqual(Object.keys(msg), ["signer_id", "deadline", "intents"]);
  assert.equal(msg.signer_id, signer);
  assert.equal(msg.deadline, new Date(deadlineMs).toISOString());
  const nonce = base64.decode(p.payload.nonce);
  assert.equal(new DataView(nonce.buffer, nonce.byteOffset).getBigInt64(9, true), BigInt(deadlineMs) * 1_000_000n);
  const pub = base58.decode(p.public_key.slice("ed25519:".length));
  assert.equal(Buffer.from(pub).toString("hex"), signer);
  assert.ok(ed25519.verify(base58.decode(p.signature.slice("ed25519:".length)), nep413Hash(p.payload.message, nonce, "intents.near"), pub));
});

test("trade diffs net to zero once the verifier's fee is charged on each negative delta", () => {
  assert.equal(intentsFee(1_000_000n, 1), 1n);
  assert.equal(intentsFee(-1n, 1), 1n);
  assert.equal(intentsFee(0n, 1), 0n);
  const usdc = "usdc.near";
  const d = tradeDiffs({ give: { token: usdc, amount: 1_000_000n }, take: { token: "wrap.near", amount: 500_000_000_000_000_000_000_000n }, feePips: 1 });
  assert.deepEqual(d.a, { [mt(usdc)]: "-1000000", [mt("wrap.near")]: "499999500000000000000000" });
  assert.deepEqual(d.b, { [mt(usdc)]: "999999", [mt("wrap.near")]: "-500000000000000000000000" });
  // per token: the two deltas plus the fee taken from the negative one sum to zero
  for (const t of [mt(usdc), mt("wrap.near")]) {
    const deltas = [BigInt(d.a[t]!), BigInt(d.b[t]!)];
    const fee = deltas.filter((x) => x < 0n).reduce((s, x) => s + intentsFee(x, 1), 0n);
    assert.equal(deltas[0]! + deltas[1]! + fee, 0n);
  }
  assert.throws(() => tradeDiffs({ give: { token: usdc, amount: 1n }, take: { token: usdc, amount: 1n }, feePips: 1 }));
});
