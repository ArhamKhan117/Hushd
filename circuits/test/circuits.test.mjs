/**
 * Circuit tests: the honest witness passes, and every rule the pool relies on
 * refuses a witness that breaks it. Witness generation runs each circuit's own
 * constraint checks, so a refused witness here is a proof nobody can make.
 * Run `pnpm compile` first.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { assetField, extHash, noteScheme, R, Tree } from "../scripts/notes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = (c) => join(root, "build", c, `${c}_js`, `${c}.wasm`);
const S = (x) => x.toString();
const zeroPath = () => ({ pathElements: Array(20).fill(0n), pathIndices: Array(20).fill(0) });

async function witnessOk(circuit, input) {
  const out = { type: "mem" };
  await snarkjs.wtns.calculate(input, wasm(circuit), out);
  return true;
}
async function refused(circuit, input) {
  await assert.rejects(snarkjs.wtns.calculate(input, wasm(circuit), { type: "mem" }));
}

let N;
const usdc = assetField("usdc.test");
const btc = assetField("btc.test");

before(async () => {
  for (const c of ["joinsplit", "receipt", "funds", "volume"]) {
    if (!existsSync(wasm(c))) throw new Error(`build/${c} missing: run pnpm compile`);
  }
  N = await noteScheme();
});

function joinsplitInput({ tree, inputs, outputs, publicAmount = 0n, publicAsset = 0n, ext = extHash(), asset = usdc, rootOverride }) {
  const paths = inputs.map((n) => (n.amount === 0n ? zeroPath() : tree.path(tree.indexOf(n.commitment))));
  return {
    root: S(rootOverride ?? tree.root()),
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
}

describe("joinsplit", () => {
  let tree, note, bobPk, dummy;
  before(() => {
    tree = new Tree(N.H);
    note = N.owned(7n, 8n, 100n, usdc);
    tree.insert(N.owned(70n, 80n, 5n, usdc).commitment);
    tree.insert(note.commitment);
    bobPk = N.receiveKey(9n);
    dummy = N.owned(1234n, 5678n, 0n, usdc);
  });

  test("a private send that conserves value passes", async () => {
    const outputs = [N.forKey(bobPk, 1n, 60n, usdc), N.forKey(N.receiveKey(7n), 2n, 40n, usdc)];
    assert.ok(await witnessOk("joinsplit", joinsplitInput({ tree, inputs: [note, dummy], outputs })));
  });

  test("a cash out with change passes", async () => {
    const outputs = [N.forKey(N.receiveKey(7n), 2n, 70n, usdc), N.forKey(bobPk, 3n, 0n, usdc)];
    assert.ok(await witnessOk("joinsplit", joinsplitInput({ tree, inputs: [note, dummy], outputs, publicAmount: 30n, publicAsset: usdc })));
  });

  test("outputs worth more than the inputs are refused", async () => {
    const outputs = [N.forKey(bobPk, 1n, 61n, usdc), N.forKey(N.receiveKey(7n), 2n, 40n, usdc)];
    await refused("joinsplit", joinsplitInput({ tree, inputs: [note, dummy], outputs }));
  });

  test("spending someone else's note is refused", async () => {
    // the right commitment and path, but the spender's own key
    const stolen = { ...note, sk: 99n, nullifier: N.nullifier(99n, note.commitment) };
    const outputs = [N.forKey(bobPk, 1n, 100n, usdc), N.forKey(bobPk, 2n, 0n, usdc)];
    await refused("joinsplit", joinsplitInput({ tree, inputs: [stolen, dummy], outputs }));
  });

  test("a note that is not in the tree is refused", async () => {
    const fake = N.owned(7n, 999n, 100n, usdc);
    const input = joinsplitInput({ tree, inputs: [dummy, dummy], outputs: [N.forKey(bobPk, 1n, 100n, usdc), N.forKey(bobPk, 2n, 0n, usdc)] });
    input.inSk[0] = S(fake.sk);
    input.inBlinding[0] = S(fake.blinding);
    input.inAmount[0] = "100";
    input.nullifier[0] = S(fake.nullifier);
    await refused("joinsplit", input);
  });

  test("a cash out that names another asset is refused", async () => {
    const outputs = [N.forKey(N.receiveKey(7n), 2n, 70n, usdc), N.forKey(bobPk, 3n, 0n, usdc)];
    await refused("joinsplit", joinsplitInput({ tree, inputs: [note, dummy], outputs, publicAmount: 30n, publicAsset: btc }));
  });

  test("a wrong nullifier is refused", async () => {
    const input = joinsplitInput({ tree, inputs: [note, dummy], outputs: [N.forKey(bobPk, 1n, 100n, usdc), N.forKey(bobPk, 2n, 0n, usdc)] });
    input.nullifier[0] = "12345";
    await refused("joinsplit", input);
  });

  test("outputs that wrap the field (r - 1 and 1 from nothing) are refused", async () => {
    // Without the 128-bit range checks these would balance: (r - 1) + 1 = 0 mod r.
    const outputs = [N.forKey(bobPk, 1n, R - 1n, usdc), N.forKey(bobPk, 2n, 1n, usdc)];
    await refused("joinsplit", joinsplitInput({ tree, inputs: [dummy, dummy], outputs }));
  });
});

describe("receipt", () => {
  const base = async (over = {}) => {
    const payerSk = 31n;
    const payeePk = N.receiveKey(41n);
    const paid = N.owned(payerSk, 5n, 60n, usdc);
    const made = N.forKey(payeePk, 6n, 50n, usdc);
    return {
      commitment: S(made.commitment), nullifier: S(paid.nullifier), asset: S(usdc), minAmount: "40", reveal: "1", shownAmount: "50",
      showPayee: "1", shownPayee: S(payeePk), context: "77", payeePk: S(payeePk), blinding: "6", amount: "50",
      inSk: S(payerSk), inBlinding: "5", inAmount: "60", ...over,
    };
  };
  test("an honest receipt passes", async () => assert.ok(await witnessOk("receipt", await base())));
  test("a minimum above the amount is refused", async () => refused("receipt", await base({ minAmount: "51" })));
  test("showing a different amount is refused", async () => refused("receipt", await base({ shownAmount: "49" })));
  test("hiding the amount shows zero", async () => assert.ok(await witnessOk("receipt", await base({ reveal: "0", shownAmount: "0" }))));
  test("someone who did not pay cannot claim the payment", async () => refused("receipt", await base({ inSk: "32" })));
});

describe("funds", () => {
  test("enough notes pass and too few are refused", async () => {
    const tree = new Tree(N.H);
    const a = N.owned(5n, 6n, 30n, btc);
    const b = N.owned(5n, 7n, 25n, btc);
    tree.insert(a.commitment);
    tree.insert(b.commitment);
    const slots = [a, b, null, null];
    const input = (threshold) => ({
      root: S(tree.root()), asset: S(btc), threshold: S(threshold), context: "1",
      nullifier: slots.map((n) => (n ? S(n.nullifier) : "0")),
      used: slots.map((n) => (n ? "1" : "0")),
      sk: slots.map((n) => (n ? S(n.sk) : "0")),
      blinding: slots.map((n) => (n ? S(n.blinding) : "0")),
      amount: slots.map((n) => (n ? S(n.amount) : "0")),
      pathElements: slots.map((n) => (n ? tree.path(tree.indexOf(n.commitment)) : zeroPath()).pathElements.map(S)),
      pathIndices: slots.map((n) => (n ? tree.path(tree.indexOf(n.commitment)) : zeroPath()).pathIndices.map(S)),
    });
    assert.ok(await witnessOk("funds", input(55n)));
    await refused("funds", input(56n));
  });
});

describe("volume", () => {
  test("the total must be the sum of the proven legs", async () => {
    const payeePk = N.receiveKey(3n);
    const paid = N.owned(9n, 4n, 10n, btc);
    const made = N.forKey(payeePk, 5n, 7n, btc);
    const slots = Array.from({ length: 16 }, (_, i) => (i === 0 ? { made, paid } : null));
    let acc = 0n;
    for (const s of slots) acc = N.H([acc, s ? s.made.commitment : 0n, s ? s.paid.nullifier : 0n]);
    const input = (total) => ({
      asset: S(btc), total: S(total), count: "1", legsHash: S(acc), context: "1",
      used: slots.map((s) => (s ? "1" : "0")),
      payeePk: slots.map((s) => (s ? S(payeePk) : "0")),
      blinding: slots.map((s) => (s ? "5" : "0")),
      amount: slots.map((s) => (s ? "7" : "0")),
      commitment: slots.map((s) => (s ? S(made.commitment) : "0")),
      inSk: slots.map((s) => (s ? "9" : "0")),
      inBlinding: slots.map((s) => (s ? "4" : "0")),
      inAmount: slots.map((s) => (s ? "10" : "0")),
      nullifier: slots.map((s) => (s ? S(paid.nullifier) : "0")),
    });
    assert.ok(await witnessOk("volume", input(7n)));
    await refused("volume", input(8n));
  });
});
