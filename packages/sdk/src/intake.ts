/**
 * Plain-language deal intake on NEAR AI Cloud, end-to-end encrypted.
 *
 * The browser encrypts the deal text to the attested model's key (X25519 from its
 * ed25519 key, HKDF-SHA256 "ed25519_encryption", XChaCha20-Poly1305), so neither the
 * Hushd API (which only adds the API key) nor the NEAR AI gateway can read it. The
 * answer comes back encrypted to a one-time client key. The browser then checks the
 * TEE's ed25519 signature over sha256(request body) and sha256(response body), and that
 * it was made by the very key the browser encrypted to: whatever signer the API names,
 * an answer signed by any other key is not verified.
 *
 * The model only drafts a package; the trader reviews it before anything is sent.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((x) => parseInt(x, 16)));

function key(shared: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, undefined, enc.encode("ed25519_encryption"), 32);
}

/** Encrypt one message field to the model's ed25519 key (wire: eph ‖ nonce ‖ ct, hex). */
export function encryptForModel(plaintext: string, modelEd25519Hex: string): string {
  const modelX = ed25519.utils.toMontgomery(unhex(modelEd25519Hex));
  const eph = x25519.utils.randomSecretKey();
  const nonce = new Uint8Array(24);
  crypto.getRandomValues(nonce);
  const ct = xchacha20poly1305(key(x25519.getSharedSecret(eph, modelX)), nonce).encrypt(enc.encode(plaintext));
  const out = new Uint8Array(32 + 24 + ct.length);
  out.set(x25519.getPublicKey(eph));
  out.set(nonce, 32);
  out.set(ct, 56);
  return hex(out);
}

/** A one-time client key pair the model encrypts its answer to. */
export function clientKey() {
  const secret = ed25519.utils.randomSecretKey();
  return { secret, publicHex: hex(ed25519.getPublicKey(secret)), x25519Secret: ed25519.utils.toMontgomerySecret(secret) };
}

export function decryptFromModel(fieldHex: string, x25519Secret: Uint8Array): string {
  const data = unhex(fieldHex);
  const shared = x25519.getSharedSecret(x25519Secret, data.slice(0, 32));
  return dec.decode(xchacha20poly1305(key(shared), data.slice(32, 56)).decrypt(data.slice(56)));
}

export const INTAKE_SYSTEM = `You turn a trader's words into an OTC package request. Answer with JSON only, no prose:
{"kind":"spot"|"spot_hedge"|"carry","sell":{"symbol":"USDC"|"wNEAR"|"BTC","amount":"<decimal>"},"buy":{"symbol":"USDC"|"wNEAR"|"BTC"},
"min_receive":"<decimal amount of the buy symbol, or null>","limit_price":"<buy per sell, or null>","hedge":true|false,"window_minutes":<1-60>,"notes":"<one short sentence>"}
Rules: "hedge it" or "with a hedge" means kind "spot_hedge" and hedge true (the maker hedges on its own account; it does not keep the trader neutral). Buying an asset with a stablecoin and shorting its perp is "carry".
Never invent an amount the trader did not give; use null. Map NEAR to wNEAR.`;

export interface IntakeDraft {
  kind: "spot" | "spot_hedge" | "carry";
  sell: { symbol: string; amount: string };
  buy: { symbol: string };
  min_receive: string | null;
  limit_price: string | null;
  hedge: boolean;
  window_minutes: number;
  notes: string;
}

/** What `/v1/intake/attestation` returns once the API has verified the model's TEE quote. */
export interface IntakeAttestation {
  model: string;
  signing_public_key: string;
  signing_address: string;
  tcb_status: string;
  gpu_evidence: "verified" | "not_provided";
  verified_at_ms: number;
  /** False when the API has no NEAR AI key: the attestation is shown, the intake is off. */
  enabled: boolean;
  verify_url: string;
}

export async function intakeAttestation(apiBase: string): Promise<IntakeAttestation> {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/v1/intake/attestation`);
  const att = (await res.json()) as IntakeAttestation & { error?: string; unavailable?: string };
  if (!res.ok || !att.signing_public_key) throw new Error(att.unavailable ?? att.error ?? "The model's attestation is unavailable");
  return att;
}

/**
 * The signing address an attestation names for an ed25519 key: the key's own 32 bytes,
 * hex, as NEAR AI's verifier compares them. Null when it is not a 32-byte key.
 */
export function ed25519SigningAddress(publicKeyHex: string): string | null {
  const h = publicKeyHex.trim().replace(/^0x/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** What the browser checked about one answer; it is verified only when every one holds. */
export interface IntakeChecks {
  /** The signed text ends with sha256(request) and sha256(response) of these exact bytes. */
  hashesMatch: boolean;
  /** The signer the API names is the attested key the words were encrypted to. */
  signerIsAttested: boolean;
  /** The signature checks out against that attested key (never a key the API supplies). */
  signatureValid: boolean;
  /** The API's own check against the verified attestation said yes. */
  apiVerified: boolean;
}

export interface IntakeResult {
  draft: IntakeDraft;
  /** Everything a reader needs to check the answer came from the attested model. */
  proof: {
    model: string;
    chatId: string;
    requestHash: string;
    responseHash: string;
    signedText: string;
    signature: string;
    /** The signer the API named for this answer. */
    signingKey: string;
    /** The attested key the words were encrypted to, and the only one accepted. */
    attestedKey: string;
    signatureKind: string;
    checks: IntakeChecks;
    verified: boolean;
  };
}

/** Check one answer's signature against the attested key; the API's word alone verifies nothing. */
export function checkIntakeAnswer(p: {
  attestedKey: string;
  attestedAddress?: string;
  requestHash: string;
  responseHash: string;
  signature: { text: string; signature: string; signing_address: string; signature_kind?: string };
  serverVerified?: boolean;
}): IntakeChecks {
  const expected = ed25519SigningAddress(p.attestedKey);
  const named = ed25519SigningAddress(p.signature.signing_address ?? "");
  // the attestation's own address must name the same key it hands out for encryption
  const attestationAgrees = p.attestedAddress === undefined || ed25519SigningAddress(p.attestedAddress) === expected;
  const signerIsAttested = expected !== null && named === expected && attestationAgrees && (p.signature.signature_kind ?? "provider_tee") === "provider_tee";
  let signatureValid = false;
  try {
    signatureValid = expected !== null && ed25519.verify(unhex(p.signature.signature), enc.encode(p.signature.text), unhex(expected));
  } catch {
    signatureValid = false;
  }
  return {
    hashesMatch: p.signature.text.endsWith(`${p.requestHash}:${p.responseHash}`),
    signerIsAttested,
    signatureValid,
    apiVerified: p.serverVerified === true,
  };
}

/** Run the intake through a Hushd API (`/v1/intake/*`). */
export async function intake(apiBase: string, text: string): Promise<IntakeResult> {
  const base = apiBase.replace(/\/$/, "");
  const att = await intakeAttestation(base);
  if (!att.enabled) throw new Error("Plain-language intake is off on this API; use the form");
  const client = clientKey();
  const body = JSON.stringify({
    model: att.model,
    messages: [
      { role: "system", content: encryptForModel(INTAKE_SYSTEM, att.signing_public_key) },
      { role: "user", content: encryptForModel(text, att.signing_public_key) },
    ],
    temperature: 0,
    stream: false,
  });
  const res = await fetch(`${base}/v1/intake/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body, clientPub: client.publicHex, modelPub: att.signing_public_key }),
  });
  const out = (await res.json()) as { response?: string; signature?: { text: string; signature: string; signing_address: string; signature_kind?: string }; error?: string; serverVerified?: boolean };
  if (!res.ok || !out.response || !out.signature) throw new Error(out.error ?? "The intake failed");
  const parsed = JSON.parse(out.response) as { id: string; choices: { message: { content: string } }[] };
  const content = decryptFromModel(parsed.choices[0]!.message.content, client.x25519Secret);
  const json = content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1);
  const draft = JSON.parse(json) as IntakeDraft;

  const requestHash = hex(sha256(enc.encode(body)));
  const responseHash = hex(sha256(enc.encode(out.response)));
  const sig = out.signature;
  const checks = checkIntakeAnswer({ attestedKey: att.signing_public_key, attestedAddress: att.signing_address, requestHash, responseHash, signature: sig, ...(out.serverVerified !== undefined ? { serverVerified: out.serverVerified } : {}) });
  return {
    draft,
    proof: {
      model: att.model,
      chatId: parsed.id,
      requestHash,
      responseHash,
      signedText: sig.text,
      signature: sig.signature,
      signingKey: sig.signing_address,
      attestedKey: att.signing_public_key,
      signatureKind: sig.signature_kind ?? "provider_tee",
      checks,
      verified: checks.hashesMatch && checks.signerIsAttested && checks.signatureValid && checks.apiVerified,
    },
  };
}
