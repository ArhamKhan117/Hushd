import assert from "node:assert/strict";
import { test } from "node:test";
import { SANCTIONS } from "../src/sanctions-list.ts";
import { addressKey, isSanctioned, normalizeAddress, sanctionsSnapshot, screenAddresses, SCREENED_MESSAGE } from "../src/screening.ts";

// two digital currency addresses on OFAC's SDN list (published 2026-11-06)
const LISTED_BECH32 = "bc1qv7k70u2zynvem59u88ctdlaw7hc735d8xep9rq";
const LISTED_BASE58 = "TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81";

test("addresses take one normal form: 0x hex and one-case addresses lowercase, mixed-case ones as written", () => {
  assert.equal(normalizeAddress("  0xABCdef0123  "), "0xabcdef0123");
  assert.equal(normalizeAddress(LISTED_BECH32.toUpperCase()), LISTED_BECH32);
  assert.equal(normalizeAddress("Alice.TESTNET"), "Alice.TESTNET");
  assert.equal(normalizeAddress("ALICE.TESTNET"), "alice.testnet");
  assert.equal(normalizeAddress(LISTED_BASE58), LISTED_BASE58);
  assert.equal(addressKey(` ${LISTED_BECH32.toUpperCase()} `), addressKey(LISTED_BECH32));
  assert.match(addressKey("alice.testnet"), /^[0-9a-f]{16}$/);
});

test("the vendored snapshot is OFAC's, dated, and holds what it says", () => {
  assert.equal(sanctionsSnapshot.source, "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML");
  assert.match(sanctionsSnapshot.published, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(sanctionsSnapshot.sourceSha256, /^[0-9a-f]{64}$/);
  assert.ok(sanctionsSnapshot.addresses > 500);
  assert.equal(SANCTIONS.keys.length, sanctionsSnapshot.addresses * 16);
  const keys = SANCTIONS.keys.match(/.{16}/g)!;
  assert.deepEqual(keys, [...new Set(keys)].sort(), "sorted, no duplicates");
});

test("a listed address is blocked in any case its format allows; others pass", () => {
  assert.ok(isSanctioned(LISTED_BECH32));
  assert.ok(isSanctioned(LISTED_BECH32.toUpperCase()), "bech32 is case-insensitive");
  assert.ok(isSanctioned(LISTED_BASE58));
  assert.ok(!isSanctioned(LISTED_BASE58.toLowerCase()), "base58 is case-sensitive: another address");
  for (const a of ["alice.testnet", "hushd.testnet", "c28d8a83efa928b37fe29ac569f912b045d86e1fabaa4f8347f56ff3c5ae8f86", "", "   "]) assert.ok(!isSanctioned(a), a);
});

test("one action is blocked if any of its addresses is listed, with one neutral message", () => {
  assert.deepEqual(screenAddresses(["alice.testnet", null, undefined, ""]), { allowed: true });
  assert.deepEqual(screenAddresses(["alice.testnet", LISTED_BASE58]), { allowed: false, message: SCREENED_MESSAGE });
  assert.equal(SCREENED_MESSAGE, "This address can't be used with Hushd.");
});

test("a wallet refuses a cash out to a listed address before it proves or asks the relayer anything", async () => {
  const { PrivateWallet } = await import("../src/wallet.ts");
  const { identityFromSeed } = await import("../src/keys.ts");
  const { TESTNET } = await import("../src/network.ts");
  await (await import("../src/poseidon.ts")).loadPoseidon();
  const asked: string[] = [];
  const relayer = new Proxy({}, { get: (_, k) => async () => void asked.push(String(k)) }) as never;
  const wallet = new PrivateWallet(TESTNET, identityFromSeed(new Uint8Array(32).fill(3)), { artifacts: {} as never, relayer });
  await assert.rejects(wallet.cashOut(LISTED_BASE58, "usdc.hushd.testnet", 1_000_000n), new RegExp(SCREENED_MESSAGE));
  assert.deepEqual(asked, []);
});
