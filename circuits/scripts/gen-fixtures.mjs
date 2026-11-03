#!/usr/bin/env node
/**
 * Real proofs for the pool contract's tests, from the dev keys. One scenario, in
 * the order the tests replay it:
 *
 *   leaf 0      Alice shields 100 USDC
 *   leaves 1,2  Alice pays Bob 60 privately, keeps 40 (transact)
 *   leaves 3,4  Alice cashes out 30 to alice.test, fee 1 to relayer.test, keeps 10 (transact)
 *   leaf 5      the maker shields 5 BTC
 *   leaves 6-9  deal 7: Bob gives the maker 50 USDC, the maker gives Bob 2 BTC (settle_swap)
 *   then        reader proofs: Bob's payment in deal 7 (receipt), Bob holds at least
 *               2 BTC (funds), the maker delivered 2 BTC across its deals (volume)
 *
 *   node scripts/gen-fixtures.mjs [out.json]
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { assetField, extHash, noteScheme, swapExtHash, Tree } from "./notes.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = here.endsWith("scripts") ? join(here, "..") : here;
const out = process.argv[2] ?? join(root, "../contracts/pool/tests/fixtures.json");
const art = (c) => ({ wasm: join(root, "build", c, `${c}_js`, `${c}.wasm`), zkey: join(root, "build", c, `${c}_final.zkey`) });

const USDC = "usdc.test";
const BTC = "btc.test";
const usdc = assetField(USDC);
const btc = assetField(BTC);
const N = await noteScheme();
const tree = new Tree(N.H);
const S = (x) => x.toString();

async function prove(circuit, input) {
  const { wasm, zkey } = art(circuit);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const vkey = await snarkjs.zKey.exportVerificationKey(zkey);
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error(`${circuit}: proof does not verify off chain`);
  return { proof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c }, publicSignals };
}

/** A dummy input: amount 0, a random key, not in the tree. */
function dummy(asset, seed) {
  return N.owned(1000n + seed, 2000n + seed, 0n, asset);
}

async function joinsplit({ inputs, outputs, publicAmount = 0n, publicAsset = 0n, ext, asset }) {
  const root = tree.root();
  const paths = inputs.map((n) => (n.amount === 0n ? { pathElements: Array(20).fill(0n), pathIndices: Array(20).fill(0) } : tree.path(tree.indexOf(n.commitment))));
  const input = {
    root: S(root),
    nullifier: inputs.map((n) => S(n.nullifier)),
    commitment: outputs.map((o) => S(o.commitment)),
    publicAmount: S(publicAmount),
    publicAsset: S(publicAsset),
    extHash: S(ext),
    asset: S(asset),
    inSk: inputs.map((n) => S(n.sk)),
    inBlinding: inputs.map((n) => S(n.blinding)),
    inAmount: inputs.map((n) => S(n.amount)),
    pathElements: paths.map((p) => p.pathElements.map(S)),
    pathIndices: paths.map((p) => p.pathIndices.map(S)),
    outPk: outputs.map((o) => S(o.pk)),
    outBlinding: outputs.map((o) => S(o.blinding)),
    outAmount: outputs.map((o) => S(o.amount)),
  };
  const { proof, publicSignals } = await prove("joinsplit", input);
  return { proof, publicSignals, root: S(root), nullifiers: inputs.map((n) => S(n.nullifier)), commitments: outputs.map((o) => S(o.commitment)) };
}

const aliceSk = 111n;
const bobSk = 222n;
const makerSk = 333n;
const alicePk = N.receiveKey(aliceSk);
const bobPk = N.receiveKey(bobSk);
const makerPk = N.receiveKey(makerSk);

// leaf 0: Alice shields 100 USDC
const a0 = N.owned(aliceSk, 11n, 100n, usdc);
const shieldAlice = { token: USDC, amount: "100", inner: S(N.inner(alicePk, 11n)), commitment: S(a0.commitment) };
tree.insert(a0.commitment);

// leaves 1,2: Alice pays Bob 60, keeps 40
const toBob = N.forKey(bobPk, 12n, 60n, usdc);
const a1 = N.owned(aliceSk, 13n, 40n, usdc);
const send = await joinsplit({ inputs: [a0, dummy(usdc, 1n)], outputs: [toBob, a1], ext: extHash(), asset: usdc });
tree.insert(toBob.commitment);
tree.insert(a1.commitment);

// leaves 3,4: Alice cashes out 30 (29 to her, 1 to the relayer), keeps 10
const cashExt = { recipient: "alice.test", relayer: "relayer.test", fee: 1n, refundInner: N.inner(alicePk, 99n), memo: null };
const a2 = N.owned(aliceSk, 14n, 10n, usdc);
const zeroOut = N.forKey(alicePk, 15n, 0n, usdc);
const cashOut = await joinsplit({ inputs: [a1, dummy(usdc, 2n)], outputs: [a2, zeroOut], publicAmount: 30n, publicAsset: usdc, ext: extHash(cashExt), asset: usdc });
tree.insert(a2.commitment);
tree.insert(zeroOut.commitment);

// leaf 5: the maker shields 5 BTC
const m0 = N.owned(makerSk, 21n, 5n, btc);
const shieldMaker = { token: BTC, amount: "5", inner: S(N.inner(makerPk, 21n)), commitment: S(m0.commitment) };
tree.insert(m0.commitment);

// deal 7: Bob 50 USDC -> maker, maker 2 BTC -> Bob
const dealId = 7n;
const bobNote = N.owned(bobSk, 12n, 60n, usdc);
const usdcToMaker = N.forKey(makerPk, 31n, 50n, usdc);
const bobChange = N.owned(bobSk, 32n, 10n, usdc);
const btcToBob = N.forKey(bobPk, 41n, 2n, btc);
const makerChange = N.owned(makerSk, 42n, 3n, btc);
const binding = swapExtHash(dealId, [usdcToMaker.commitment, bobChange.commitment], [btcToBob.commitment, makerChange.commitment]);
const legA = await joinsplit({ inputs: [bobNote, dummy(usdc, 3n)], outputs: [usdcToMaker, bobChange], ext: binding, asset: usdc });
const legB = await joinsplit({ inputs: [m0, dummy(btc, 4n)], outputs: [btcToBob, makerChange], ext: binding, asset: btc });
for (const c of [usdcToMaker, bobChange, btcToBob, makerChange]) tree.insert(c.commitment);

// receipt: Bob paid the maker at least 40 USDC in deal 7, amount shown, payee hidden
const context = 4242n;
const receipt = await prove("receipt", {
  commitment: S(usdcToMaker.commitment),
  nullifier: S(bobNote.nullifier),
  asset: S(usdc),
  minAmount: "40",
  reveal: "1",
  shownAmount: "50",
  showPayee: "0",
  shownPayee: "0",
  context: S(context),
  payeePk: S(makerPk),
  blinding: "31",
  amount: "50",
  inSk: S(bobSk),
  inBlinding: "12",
  inAmount: "60",
});

// funds: Bob holds at least 2 BTC
const bobBtc = N.owned(bobSk, 41n, 2n, btc);
const fundsSlots = [bobBtc, null, null, null];
const fundsPaths = fundsSlots.map((n) => (n ? tree.path(tree.indexOf(n.commitment)) : { pathElements: Array(20).fill(0n), pathIndices: Array(20).fill(0) }));
const funds = await prove("funds", {
  root: S(tree.root()),
  asset: S(btc),
  threshold: "2",
  context: S(context),
  nullifier: fundsSlots.map((n) => (n ? S(n.nullifier) : "0")),
  used: fundsSlots.map((n) => (n ? "1" : "0")),
  sk: fundsSlots.map((n) => (n ? S(n.sk) : "0")),
  blinding: fundsSlots.map((n) => (n ? S(n.blinding) : "0")),
  amount: fundsSlots.map((n) => (n ? S(n.amount) : "0")),
  pathElements: fundsPaths.map((p) => p.pathElements.map(S)),
  pathIndices: fundsPaths.map((p) => p.pathIndices.map(S)),
});

// volume: the maker delivered 2 BTC in one deal leg
const legs = [{ c: btcToBob.commitment, n: m0.nullifier, payeePk: bobPk, blinding: 41n, amount: 2n, inSk: makerSk, inBlinding: 21n, inAmount: 5n }];
let acc = 0n;
const slots = Array.from({ length: 16 }, (_, i) => legs[i] ?? null);
for (const l of slots) acc = N.H([acc, l ? l.c : 0n, l ? l.n : 0n]);
const volume = await prove("volume", {
  asset: S(btc),
  total: "2",
  count: "1",
  legsHash: S(acc),
  context: S(context),
  used: slots.map((l) => (l ? "1" : "0")),
  payeePk: slots.map((l) => (l ? S(l.payeePk) : "0")),
  blinding: slots.map((l) => (l ? S(l.blinding) : "0")),
  amount: slots.map((l) => (l ? S(l.amount) : "0")),
  commitment: slots.map((l) => (l ? S(l.c) : "0")),
  inSk: slots.map((l) => (l ? S(l.inSk) : "0")),
  inBlinding: slots.map((l) => (l ? S(l.inBlinding) : "0")),
  inAmount: slots.map((l) => (l ? S(l.inAmount) : "0")),
  nullifier: slots.map((l) => (l ? S(l.n) : "0")),
});

const fixture = {
  tokens: { usdc: USDC, btc: BTC },
  assetFields: { usdc: S(usdc), btc: S(btc) },
  shieldAlice,
  send,
  cashOut: { ...cashOut, ext: { recipient: cashExt.recipient, relayer: cashExt.relayer, fee: "1", refund_inner: S(cashExt.refundInner) }, publicAmount: "30" },
  shieldMaker,
  swap: { dealId: S(dealId), legA, legB },
  receipt,
  funds,
  volume: { ...volume, legs: legs.map((l) => [S(l.c), S(l.n)]) },
  rootAfterAll: S(tree.root()),
};
writeFileSync(out, JSON.stringify(fixture, null, 1));
console.log(`wrote ${out}`);
process.exit(0);
