/**
 * Passkey key wrapping: plain WebCrypto, so it runs in the browser and in Node.
 *
 * The data key that encrypts notes at rest is wrapped under a key-encryption
 * key (KEK) derived from a passkey's PRF output (the WebAuthn `prf` extension,
 * hmac-secret on security keys). The PRF output never touches disk: without
 * the passkey, the stored record below is only ciphertext and public values.
 *
 *   PRF output --HKDF-SHA256(kdfSalt, info)--> KEK (AES-GCM, wrap only)
 *   KEK --AES-GCM(iv, aad = credential id)--> wrapped data key
 */

export type PasskeyWrapRecord = {
  v: 1;
  /** WebAuthn credential id (base64url). Public. */
  credentialId: string;
  /** RP id the passkey is bound to (this site's host). */
  rpId: string;
  /** PRF input (base64). Public: the PRF output is what stays secret. */
  prfSalt: string;
  /** HKDF salt (base64). */
  kdfSalt: string;
  /** AES-GCM IV used to wrap the data key (base64). */
  iv: string;
  /** The wrapped data key (base64). */
  wrapped: string;
  createdAt: number;
};

const HKDF_INFO = "hushd/vault/passkey-kek/v1";

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function b64url(bytes: Uint8Array): string {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return unb64(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto's BufferSource typing). */
export function bytes(src: ArrayBuffer | ArrayBufferView): Uint8Array<ArrayBuffer> {
  const view =
    src instanceof ArrayBuffer
      ? new Uint8Array(src)
      : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  const out = new Uint8Array(view.byteLength);
  out.set(view);
  return out;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

function aad(credentialId: string): Uint8Array<ArrayBuffer> {
  return bytes(new TextEncoder().encode(`hushd-vault|${credentialId}`));
}

/** A fresh AES-GCM data key. Extractable only so it can be wrapped once. */
export function newWrappableDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/** KEK = HKDF-SHA256(PRF output). Non-extractable, wrap/unwrap only. */
export async function deriveKek(prfOutput: Uint8Array, kdfSalt: Uint8Array): Promise<CryptoKey> {
  if (prfOutput.byteLength < 32) throw new Error("Passkey output too short.");
  const base = await crypto.subtle.importKey("raw", bytes(prfOutput), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytes(kdfSalt),
      info: bytes(new TextEncoder().encode(HKDF_INFO)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

/** Wrap `dataKey` under the passkey. Returns the record fields that go to disk. */
export async function wrapDataKey(
  dataKey: CryptoKey,
  prfOutput: Uint8Array,
  credentialId: string
): Promise<Pick<PasskeyWrapRecord, "kdfSalt" | "iv" | "wrapped">> {
  const kdfSalt = randomBytes(32);
  const iv = randomBytes(12);
  const kek = await deriveKek(prfOutput, kdfSalt);
  const wrapped = new Uint8Array(
    await crypto.subtle.wrapKey("raw", dataKey, kek, {
      name: "AES-GCM",
      iv,
      additionalData: aad(credentialId),
    })
  );
  return { kdfSalt: b64(kdfSalt), iv: b64(iv), wrapped: b64(wrapped) };
}

/**
 * Unwrap the data key with the passkey's PRF output. The result is
 * non-extractable. Throws if the output (or the record) is wrong.
 */
export async function unwrapDataKey(
  record: Pick<PasskeyWrapRecord, "credentialId" | "kdfSalt" | "iv" | "wrapped">,
  prfOutput: Uint8Array
): Promise<CryptoKey> {
  const kek = await deriveKek(prfOutput, unb64(record.kdfSalt));
  return crypto.subtle.unwrapKey(
    "raw",
    unb64(record.wrapped),
    kek,
    { name: "AES-GCM", iv: unb64(record.iv), additionalData: aad(record.credentialId) },
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** Parse a stored record, or null if it is missing or malformed. */
export function parseWrapRecord(raw: string | null): PasskeyWrapRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<PasskeyWrapRecord>;
    if (
      r?.v === 1 &&
      typeof r.credentialId === "string" &&
      typeof r.rpId === "string" &&
      typeof r.prfSalt === "string" &&
      typeof r.kdfSalt === "string" &&
      typeof r.iv === "string" &&
      typeof r.wrapped === "string"
    ) {
      return r as PasskeyWrapRecord;
    }
  } catch {
    /* fall through */
  }
  return null;
}
