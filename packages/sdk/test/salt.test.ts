import assert from "node:assert/strict";
import { test } from "node:test";
import { packageRequest } from "../src/desk.ts";
import { identityFromSeed } from "../src/keys.ts";
import { MAINNET, TESTNET, withOverrides } from "../src/network.ts";
import { loadPoseidon } from "../src/poseidon.ts";

const draft = { kind: "spot" as const, sell: { token: "usdc.hushd.testnet", amount: 1_000_000_000n }, buy: { token: "btc.hushd.testnet", minAmount: 1n } };

test("a request is salted when the network says so, and the makers' ask carries the same salt", async () => {
  await loadPoseidon();
  const id = identityFromSeed(new Uint8Array(32).fill(1));
  const plain = packageRequest(id, withOverrides(TESTNET, { termsSalt: false }), draft);
  assert.equal("salt" in plain.request, false);
  assert.equal(plain.ask.salt, undefined);

  const salted = packageRequest(id, withOverrides(TESTNET, { termsSalt: true }), draft);
  const salt = (salted.request as { salt?: string }).salt!;
  assert.match(salt, /^0x[0-9a-f]{64}$/);
  assert.equal(salted.ask.salt, salt);
  assert.notEqual(salt, (packageRequest(id, withOverrides(TESTNET, { termsSalt: true }), draft).request as { salt?: string }).salt, "a fresh salt per request");
  assert.equal(MAINNET.termsSalt, true, "mainnet starts salted");
});
