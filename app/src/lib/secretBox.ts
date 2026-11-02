/**
 * Passphrase seal/open for browser JSON (AES-GCM + PBKDF2).
 * Used for optional encrypted vault note backups.
 */

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

/** PBKDF2 rounds: OWASP's floor for PBKDF2-SHA256. */
const PBKDF2_ROUNDS = 310_000;

async function deriveKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ROUNDS): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    buf(utf8(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: buf(salt),
      iterations,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const PREFIX = "hushdbak1.";

/** Seal arbitrary UTF-8 text with a passphrase. */
export async function sealWithPassphrase(
  plain: string,
  passphrase: string
): Promise<string> {
  if (!passphrase.trim()) throw new Error("Passphrase required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase.trim(), salt);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(iv) },
      key,
      buf(utf8(plain))
    )
  );
  const out = new Uint8Array(salt.length + iv.length + cipher.length);
  out.set(salt, 0);
  out.set(iv, 16);
  out.set(cipher, 28);
  return PREFIX + b64urlEncode(out);
}

export function isSealedBackup(input: string): boolean {
  return input.trim().startsWith(PREFIX);
}

/** Open sealed text. */
export async function openWithPassphrase(
  sealed: string,
  passphrase: string
): Promise<string> {
  const s = sealed.trim();
  if (!s.startsWith(PREFIX)) {
    throw new Error("Not a locked Hushd backup.");
  }
  if (!passphrase.trim()) throw new Error("Passphrase required");
  const raw = b64urlDecode(s.slice(PREFIX.length));
  if (raw.length < 29) throw new Error("Corrupt backup.");
  const salt = raw.slice(0, 16);
  const iv = raw.slice(16, 28);
  const cipher = raw.slice(28);
  const key = await deriveKey(passphrase.trim(), salt);
  try {
    const plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: buf(iv) },
        key,
        buf(cipher)
      )
    );
    return utf8Decode(plain);
  } catch {
    throw new Error("Wrong passphrase or corrupt backup.");
  }
}
