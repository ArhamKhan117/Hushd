/**
 * Where a Hushd seed comes from in the browser, and the keys derived from it.
 *
 * - A NEAR wallet signs one fixed NEP-413 message (same message, same nonce): the seed
 *   is a hash of that signature, so the same wallet key unlocks the same private balance
 *   on any device and nothing secret is ever stored.
 * - A passkey's WebAuthn PRF output is the seed. It also derives a NEAR key for an
 *   implicit account, so someone with no wallet can still sign their own deposits.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

const enc = new TextEncoder();
const tag = (s: string) => sha256(enc.encode(s));

export const SEED_RECIPIENT = "hushd.net";
/** The fixed 32-byte NEP-413 nonce: a seed, not a login, so it never changes. */
export const SEED_NONCE = tag("hushd.seed.nonce.v1");
const PRF_SALT = tag("hushd.passkey.prf.v1");

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** The key that signs transactions for a passkey's own implicit NEAR account. */
export function nearKeyFromSeed(seed: Uint8Array): { secretKey: string; publicKey: string; implicitAccount: string } {
  const sk = sha256(concat(enc.encode("hushd.near.v1"), seed));
  const pk = ed25519.getPublicKey(sk);
  const implicitAccount = Array.from(pk, (b) => b.toString(16).padStart(2, "0")).join("");
  return { secretKey: `ed25519:${base58.encode(concat(sk, pk))}`, publicKey: `ed25519:${base58.encode(pk)}`, implicitAccount };
}

/** AES-GCM key that encrypts this identity's notes at rest. */
export async function storeKey(seed: Uint8Array): Promise<CryptoKey> {
  const raw = sha256(concat(enc.encode("hushd.store.v1"), seed));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export function passkeySupported(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window;
}

type PrfResults = { prf?: { results?: { first?: ArrayBuffer }; enabled?: boolean } };

/** Create a passkey for Hushd and return its PRF seed. */
export async function createPasskey(): Promise<Uint8Array> {
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Hushd", id: location.hostname },
      user: { id: userId, name: "Hushd private balance", displayName: "Hushd" },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("The passkey was not created");
  const ext = cred.getClientExtensionResults() as PrfResults;
  if (ext.prf?.results?.first) return new Uint8Array(ext.prf.results.first);
  if (ext.prf?.enabled === false) throw new Error("This passkey cannot derive keys (no PRF support). Try another device or a NEAR wallet.");
  // Some platforms only return PRF output on sign-in, not on creation.
  return unlockPasskey();
}

/** Sign in with an existing Hushd passkey and return its PRF seed. */
export async function unlockPasskey(): Promise<Uint8Array> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const first = (cred?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
  if (!first) throw new Error("This passkey cannot derive keys (no PRF support). Try another device or a NEAR wallet.");
  return new Uint8Array(first);
}
