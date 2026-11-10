/** NEAR AI intake, with the Hushd API and the model stubbed: an answer counts only when the attested key signed it. */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519SigningAddress, encryptForModel, intake, type IntakeDraft } from "../src/intake.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const keyPair = (fill: number) => {
  const secret = new Uint8Array(32).fill(fill);
  return { secret, pub: hex(ed25519.getPublicKey(secret)) };
};
const model = keyPair(1);
const intruder = keyPair(2);
const DRAFT: IntakeDraft = { kind: "spot", sell: { symbol: "USDC", amount: "100" }, buy: { symbol: "BTC" }, min_receive: null, limit_price: null, hedge: false, window_minutes: 1, notes: "Sell 100 USDC for BTC." };

interface Stub {
  /** The attestation the API hands out (the model's key unless changed). */
  attestation?: Partial<{ signing_public_key: string; signing_address: string }>;
  /** Who signs the answer, and which signer the API names for it. */
  signer?: { secret: Uint8Array; named: string };
  /** The API's own verdict; left out when undefined. */
  serverVerified?: boolean;
  /** Sign a response other than the one returned. */
  signOther?: boolean;
}

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

function stubApi(o: Stub = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/intake/attestation")) {
      return Response.json({ model: "test/model", signing_public_key: model.pub, signing_address: model.pub, tcb_status: "UpToDate", gpu_evidence: "verified", verified_at_ms: 1, enabled: true, verify_url: "https://example.test/verify", ...o.attestation });
    }
    if (url.endsWith("/v1/intake/chat")) {
      const b = JSON.parse(String(init?.body)) as { body: string; clientPub: string; modelPub: string };
      // the model answers encrypted to the browser's one-time key
      const response = JSON.stringify({ id: "chat-1", choices: [{ message: { content: encryptForModel(JSON.stringify(DRAFT), b.clientPub) } }] });
      const signed = o.signOther ? `${response} ` : response;
      const text = `test/model:${hex(sha256(new TextEncoder().encode(b.body)))}:${hex(sha256(new TextEncoder().encode(signed)))}`;
      const signer = o.signer ?? { secret: model.secret, named: model.pub };
      const signature = { text, signature: hex(ed25519.sign(new TextEncoder().encode(text), signer.secret)), signing_address: signer.named, signature_kind: "provider_tee" };
      return Response.json({ response, signature, ...(o.serverVerified === undefined ? {} : { serverVerified: o.serverVerified }) });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

test("an answer signed by the attested key, and confirmed by the API, is verified", async () => {
  stubApi({ serverVerified: true });
  const r = await intake("https://api.example.test", "sell 100 USDC for BTC");
  assert.deepEqual(r.draft, DRAFT);
  assert.deepEqual(r.proof.checks, { hashesMatch: true, signerIsAttested: true, signatureValid: true, apiVerified: true });
  assert.equal(r.proof.verified, true);
  assert.equal(r.proof.attestedKey, model.pub);
});

test("an API that swaps in its own signing key gets no verified answer", async () => {
  // the API names its own key as the signer and signs with it
  stubApi({ serverVerified: true, signer: { secret: intruder.secret, named: intruder.pub } });
  const swapped = await intake("https://api.example.test", "sell 100 USDC for BTC");
  assert.equal(swapped.proof.verified, false);
  assert.equal(swapped.proof.checks.signerIsAttested, false);
  assert.equal(swapped.proof.checks.signatureValid, false);
  // or names the attested key while signing with its own
  stubApi({ serverVerified: true, signer: { secret: intruder.secret, named: model.pub } });
  const forged = await intake("https://api.example.test", "sell 100 USDC for BTC");
  assert.equal(forged.proof.verified, false);
  assert.equal(forged.proof.checks.signerIsAttested, true);
  assert.equal(forged.proof.checks.signatureValid, false);
});

test("an answer is not verified when the API says nothing, or when the attestation names another signer", async () => {
  stubApi();
  const silent = await intake("https://api.example.test", "sell 100 USDC for BTC");
  assert.equal(silent.proof.checks.apiVerified, false);
  assert.equal(silent.proof.verified, false);
  stubApi({ serverVerified: false });
  assert.equal((await intake("https://api.example.test", "sell 100 USDC for BTC")).proof.verified, false);
  // an attestation whose signing address is not the key it hands out for encryption
  stubApi({ serverVerified: true, attestation: { signing_address: intruder.pub }, signer: { secret: model.secret, named: intruder.pub } });
  const mismatched = await intake("https://api.example.test", "sell 100 USDC for BTC");
  assert.equal(mismatched.proof.checks.signerIsAttested, false);
  assert.equal(mismatched.proof.verified, false);
});

test("a signature over another response does not verify this one", async () => {
  stubApi({ serverVerified: true, signOther: true });
  const r = await intake("https://api.example.test", "sell 100 USDC for BTC");
  assert.equal(r.proof.checks.hashesMatch, false);
  assert.equal(r.proof.verified, false);
});

test("an ed25519 key's signing address is the key itself, in lowercase hex", () => {
  assert.equal(ed25519SigningAddress(`0x${model.pub.toUpperCase()}`), model.pub);
  assert.equal(ed25519SigningAddress("0x1234"), null);
  assert.equal(ed25519SigningAddress(`0x${"ab".repeat(20)}`), null);
});
