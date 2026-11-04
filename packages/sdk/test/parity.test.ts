/**
 * The SDK must agree with the contracts and circuits byte for byte. These checks
 * replay the real proof fixtures the pool's own tests use.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import { assetField, extHash, swapExtHash } from "../src/field.ts";
import { loadPoseidon, poseidon } from "../src/poseidon.ts";
import { MerkleTree } from "../src/tree.ts";

const root = join(import.meta.dirname, "../../..");
const fx = JSON.parse(readFileSync(join(root, "contracts/pool/tests/fixtures.json"), "utf8"));

before(loadPoseidon);

test("asset ids match the pool", () => {
  assert.equal(assetField(fx.tokens.usdc).toString(), fx.assetFields.usdc);
  assert.equal(assetField(fx.tokens.btc).toString(), fx.assetFields.btc);
});

test("ext hashes match what the cash out proof binds", () => {
  const e = fx.cashOut.ext;
  const h = extHash({ recipient: e.recipient, relayer: e.relayer, fee: BigInt(e.fee), refundInner: BigInt(e.refund_inner) });
  assert.equal(h.toString(), fx.cashOut.publicSignals[7]);
  assert.equal(extHash().toString(), fx.send.publicSignals[7]);
});

test("the swap binding matches both legs", () => {
  const a = fx.swap.legA.commitments.map(BigInt) as [bigint, bigint];
  const b = fx.swap.legB.commitments.map(BigInt) as [bigint, bigint];
  const h = swapExtHash(BigInt(fx.swap.dealId), a, b).toString();
  assert.equal(h, fx.swap.legA.publicSignals[7]);
  assert.equal(h, fx.swap.legB.publicSignals[7]);
});

test("the tree rebuilt from the leaves has the pool's roots", () => {
  const shieldAlice = BigInt(fx.shieldAlice.commitment);
  const t = new MerkleTree([shieldAlice]);
  assert.equal(t.root().toString(), fx.send.root);
  for (const c of fx.send.commitments) t.insert(BigInt(c));
  assert.equal(t.root().toString(), fx.cashOut.root);
  for (const c of fx.cashOut.commitments) t.insert(BigInt(c));
  t.insert(BigInt(fx.shieldMaker.commitment));
  assert.equal(t.root().toString(), fx.swap.legA.root);
  for (const c of [...fx.swap.legA.commitments, ...fx.swap.legB.commitments]) t.insert(BigInt(c));
  assert.equal(t.root().toString(), fx.rootAfterAll);
  assert.equal(poseidon([1n, 2n]), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
});
