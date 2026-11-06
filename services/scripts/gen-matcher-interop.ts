/**
 * Writes matcher/tests/interop.json: a sealed RFQ and two signed, sealed quotes made the
 * way the trader's agent and the makers make them in TypeScript, for a test-only enclave
 * key. The Rust matcher's test must open them, check both makers' signatures (consent v2,
 * for desk.hushd.testnet), pick the better quote and arrive at the same terms hash.
 *
 *   pnpm --filter @hushd/services exec tsx scripts/gen-matcher-interop.ts
 */
import { writeFileSync } from "node:fs";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { hex, quoteConsent, termsHash, termsOf, toJson, type PackageQuote, type PackageRequest } from "@hushd/protocol";
import { identityFromSeed, loadPoseidon, seal, toHex, toB64 } from "@hushd/sdk";

await loadPoseidon();
const enc = new TextEncoder();
const desk = "desk.hushd.testnet";
const enclaveSeed = new Uint8Array(32).fill(42);
const encSecret = sha256(new Uint8Array([...enc.encode("hushd.matcher.enc.v1"), ...enclaveSeed]));
const enclaveEnc = x25519.getPublicKey(encSecret);

const trader = identityFromSeed(new Uint8Array(32).fill(1));
const makerA = identityFromSeed(new Uint8Array(32).fill(2));
const makerB = identityFromSeed(new Uint8Array(32).fill(3));
const quoteSecret = (n: number) => new Uint8Array(32).fill(n);
const quoteKey = (sk: Uint8Array) => `ed25519:${base58.encode(ed25519.getPublicKey(sk))}`;
const ownerKey = `ed25519:${base58.encode(ed25519.getPublicKey(new Uint8Array(32).fill(9)))}`;

const now = 1_800_000_000_000;
const req: PackageRequest = {
  v: 1,
  kind: "spot",
  sell: { token: "usdc.hushd.testnet", amount: 1_000_000_000n },
  buy: { token: "btc.hushd.testnet", minAmount: 1_500_000n },
  expiresInMs: 60_000,
  trader: { address: trader.address, refundInner: toHex(123456789n), ownerKey },
};
const rfqBox = seal(enclaveEnc, enc.encode(toJson(req)));
const commitment = hex(sha256(rfqBox));

function quote(maker: string, makerAddress: string, sk: Uint8Array, give: bigint): PackageQuote {
  const q: PackageQuote = {
    v: 1, rfqId: 5, maker, give: { token: "btc.hushd.testnet", amount: give }, take: { token: "usdc.hushd.testnet", amount: 1_000_000_000n },
    bond: 0n, expiresAtMs: now + 300_000, makerAddress, quoteKey: quoteKey(sk), signature: "",
  };
  q.signature = toB64(ed25519.sign(quoteConsent(desk, q, "spot"), sk));
  return q;
}
const qa = quote("maker-a.hushd.testnet", makerA.address, quoteSecret(11), 1_550_000n);
const qb = quote("maker-b.hushd.testnet", makerB.address, quoteSecret(12), 1_620_000n);
const forged = { ...quote("maker-a.hushd.testnet", makerA.address, quoteSecret(11), 9_999_999n), signature: qa.signature };
const batch = { rfq: toB64(rfqBox), quotes: [qa, qb, forged].map((q) => toB64(seal(enclaveEnc, enc.encode(toJson(q))))) };

writeFileSync(
  new URL("../../matcher/tests/interop.json", import.meta.url),
  JSON.stringify({
    enclaveSeedHex: Buffer.from(enclaveSeed).toString("hex"),
    nowNs: String(BigInt(now) * 1_000_000n),
    input: { cmd: "match", desk, rfq_id: "5", rfq_commitment: commitment, batch: Buffer.from(JSON.stringify(batch)).toString("base64") },
    expect: { maker: qb.maker, termsHash: hex(termsHash(termsOf(qb, "spot"))), refused: 1, traderEncKey: hex(trader.encPublic) },
  }, null, 1),
);
console.log("wrote matcher/tests/interop.json");
