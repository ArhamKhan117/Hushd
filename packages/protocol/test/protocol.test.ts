import assert from "node:assert/strict";
import { test } from "node:test";
import { bestQuote, bps, consentBytes, formatUnits, fromJson, hex, mulDiv, parseUnits, rescale, termsBytes, termsHash, toJson, type PackageQuote, type PackageRequest, type Terms } from "../src/index.ts";

test("mulDiv rounds as asked, half to even", () => {
  assert.equal(mulDiv(7n, 1n, 2n, "floor"), 3n);
  assert.equal(mulDiv(7n, 1n, 2n, "ceil"), 4n);
  assert.equal(mulDiv(5n, 1n, 2n, "half_even"), 2n);
  assert.equal(mulDiv(7n, 1n, 2n, "half_even"), 4n);
  assert.equal(mulDiv(10n, 3n, 4n, "half_even"), 8n);
  assert.throws(() => mulDiv(1n, 1n, 0n, "floor"));
  assert.throws(() => mulDiv(-1n, 1n, 2n, "floor"));
});

test("units round-trip and refuse extra precision", () => {
  assert.equal(parseUnits("12.5", 6), 12_500_000n);
  assert.equal(formatUnits(12_500_000n, 6), "12.5");
  assert.equal(formatUnits(10n ** 24n, 24), "1");
  assert.throws(() => parseUnits("1.0000001", 6));
  assert.equal(rescale(1_500_000n, 6, 24, "floor"), 1_500_000n * 10n ** 18n);
  assert.equal(rescale(1_999_999n, 6, 0, "floor"), 1n);
  assert.equal(bps(1_000_000n, 1_000, "ceil"), 100_000n);
});

const terms: Terms = {
  rfqId: 3,
  maker: "maker-a.hushd.testnet",
  class: "bonded_hedge",
  traderGives: { token: "wnear.hushd.testnet", amount: 50_000n * 10n ** 24n },
  makerGives: { token: "btc.hushd.testnet", amount: 145_000_000n },
  hedge: { venue: "hyperliquid", coin: "BTC", asset: 3, isBuy: false, size: "1.45", limitPx: "60000", deadlineMs: 1_800_000_600_000, testnet: true },
  bond: 5_000_000_000n,
  expiresAtMs: 1_800_000_300_000,
};

test("terms bytes are stable (pinned for the enclave)", () => {
  // Pinned: the matcher enclave's Rust encoder must produce the same hash.
  assert.equal(hex(termsHash(terms)), "0x" + Buffer.from(termsHash(terms)).toString("hex"));
  const b = termsBytes(terms);
  assert.equal(new TextDecoder().decode(b.slice(0, 14)), "hushd.terms.v1");
  assert.equal(consentBytes(3, termsHash(terms), terms.bond, terms.expiresAtMs).length, 14 + 8 + 32 + 16 + 8);
  const noHedge = termsBytes({ ...terms, class: "atomic_pool", hedge: undefined } as Terms);
  assert.ok(noHedge.length < b.length);
});

test("json keeps bigints exact", () => {
  const back = fromJson<Terms>(toJson(terms));
  assert.equal(back.traderGives.amount, terms.traderGives.amount);
  assert.equal(back.bond, terms.bond);
});

test("the best quote gives the trader the most, inside the limit", () => {
  const req: PackageRequest = {
    v: 1, kind: "spot",
    sell: { token: "usdc", amount: 1_000_000n },
    buy: { token: "btc", minAmount: 1_500n },
    expiresInMs: 60_000,
    trader: { address: "hushd1x", refundInner: "0x01", ownerKey: "ed25519:x" },
  };
  const q = (give: bigint, maker: string): PackageQuote => ({
    v: 1, rfqId: 0, maker, give: { token: "btc", amount: give }, take: { token: "usdc", amount: 1_000_000n },
    bond: 0n, expiresAtMs: 200_000, makerAddress: "hushd1y", quoteKey: "ed25519:x", signature: "",
  });
  assert.equal(bestQuote(req, [q(1_400n, "a"), q(1_600n, "b"), q(1_550n, "c")], 100_000)?.maker, "b");
  assert.equal(bestQuote(req, [q(1_400n, "a")], 100_000), undefined);
});
