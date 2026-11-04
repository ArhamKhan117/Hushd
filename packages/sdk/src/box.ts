/**
 * Sealed boxes: encrypt to an X25519 public key so only its holder can read it.
 * Used for board posts (note openings for a recipient), RFQs and quotes sealed to
 * the matcher enclave, and deal terms the enclave returns to each side.
 *
 *   eph      = fresh X25519 key pair
 *   key      = HKDF-SHA256(ikm = X25519(eph, recipient), salt = eph.pub ‖ recipient, info = "hushd.box.v1")
 *   box      = eph.pub (32) ‖ nonce (24) ‖ XChaCha20-Poly1305(key, nonce, plaintext)
 *
 * The matcher enclave implements the same scheme in Rust (matcher/src/box_.rs).
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concat } from "./field.js";

const INFO = new TextEncoder().encode("hushd.box.v1");

function boxKey(shared: Uint8Array, ephPublic: Uint8Array, recipient: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(ephPublic, recipient), INFO, 32);
}

export function seal(recipient: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPublic = x25519.getPublicKey(ephSecret);
  const key = boxKey(x25519.getSharedSecret(ephSecret, recipient), ephPublic, recipient);
  const nonce = new Uint8Array(24);
  crypto.getRandomValues(nonce);
  return concat(ephPublic, nonce, xchacha20poly1305(key, nonce).encrypt(plaintext));
}

/** The plaintext, or null when the box is not for this key (or was tampered with). */
export function open(secret: Uint8Array, box: Uint8Array): Uint8Array | null {
  if (box.length < 32 + 24 + 16) return null;
  const ephPublic = box.slice(0, 32);
  const nonce = box.slice(32, 56);
  const recipient = x25519.getPublicKey(secret);
  try {
    const key = boxKey(x25519.getSharedSecret(secret, ephPublic), ephPublic, recipient);
    return xchacha20poly1305(key, nonce).decrypt(box.slice(56));
  } catch {
    return null;
  }
}

export function sealJson(recipient: Uint8Array, value: unknown): Uint8Array {
  return seal(recipient, new TextEncoder().encode(JSON.stringify(value)));
}

export function openJson<T>(secret: Uint8Array, box: Uint8Array): T | null {
  const plain = open(secret, box);
  if (!plain) return null;
  try {
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
}
