/** Private x402: the server accepts exactly the note the pool created for it, once. */
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { sealJson } from "../src/box.ts";
import { noteMessage } from "../src/board.ts";
import { toB64, utf8ToB64 } from "../src/bytes.ts";
import { identityFromSeed } from "../src/keys.ts";
import { TESTNET } from "../src/network.ts";
import { makeNote } from "../src/note.ts";
import { loadPoseidon } from "../src/poseidon.ts";
import { verifyX402Payment } from "../src/x402.ts";

const USDC = "usdc.hushd.testnet";
before(() => loadPoseidon());

function setup(amount: bigint, opts: { poolLogs?: boolean; sealTo?: "payee" | "other" } = {}) {
  const payee = identityFromSeed(new Uint8Array(32).fill(7));
  const other = identityFromSeed(new Uint8Array(32).fill(9));
  const note = makeNote(payee.pk, USDC, amount);
  const sealFor = opts.sealTo === "other" ? other : payee;
  const payload = { txHash: "tx1", sender: "relayer.hushd.testnet", commitment: note.commitment.toString(), opening: toB64(sealJson(sealFor.encPublic, noteMessage(note))) };
  const header = utf8ToB64(JSON.stringify({ x402Version: 1, scheme: "hushd", network: "near-testnet", payload }));
  const ev = { standard: "hushd", version: "1.0.0", event: "transact", data: [{ commitments: [`0x${note.commitment.toString(16)}`, "0x01"] }] };
  const tx = {
    status: { SuccessValue: "" },
    receipts_outcome: [{ outcome: { executor_id: opts.poolLogs === false ? "other.testnet" : TESTNET.pool!, logs: [`EVENT_JSON:${JSON.stringify(ev)}`], status: { SuccessValue: "" } } }],
  };
  return { payee, header, fetchTx: async () => tx };
}

test("a good payment is accepted once", async () => {
  const { payee, header, fetchTx } = setup(10_000n);
  const seen = new Set<string>();
  const ok = await verifyX402Payment(TESTNET, payee, header, { asset: USDC, maxAmountRequired: "10000" }, seen, fetchTx);
  assert.equal(ok.ok, true);
  const again = await verifyX402Payment(TESTNET, payee, header, { asset: USDC, maxAmountRequired: "10000" }, seen, fetchTx);
  assert.deepEqual(again, { ok: false, reason: "this payment was already used" });
});

test("underpaying, a wrong token, a note sealed to someone else and a note not from the pool are refused", async () => {
  const under = setup(9_999n);
  assert.equal((await verifyX402Payment(TESTNET, under.payee, under.header, { asset: USDC, maxAmountRequired: "10000" }, new Set(), under.fetchTx)).ok, false);
  const token = setup(10_000n);
  assert.equal((await verifyX402Payment(TESTNET, token.payee, token.header, { asset: "btc.hushd.testnet", maxAmountRequired: "1" }, new Set(), token.fetchTx)).ok, false);
  const sealed = setup(10_000n, { sealTo: "other" });
  assert.equal((await verifyX402Payment(TESTNET, sealed.payee, sealed.header, { asset: USDC, maxAmountRequired: "1" }, new Set(), sealed.fetchTx)).ok, false);
  const notPool = setup(10_000n, { poolLogs: false });
  const r = await verifyX402Payment(TESTNET, notPool.payee, notPool.header, { asset: USDC, maxAmountRequired: "1" }, new Set(), notPool.fetchTx);
  assert.deepEqual(r, { ok: false, reason: "the pool did not create this note in that transaction" });
});
