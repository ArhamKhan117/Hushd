/**
 * A Hushd identity: the spending key behind your notes, its receive key, and the
 * X25519 key notes and deal terms are encrypted to. Everything comes from one 32-byte
 * seed (a NEP-413 wallet signature, a passkey's PRF output, or random bytes for an agent).
 *
 *   sk  = hashToField("hushd.sk.v1" ‖ seed)          spends notes (never leaves the device)
 *   pk  = Poseidon(sk)                               receive key: notes made for it are yours
 *   enc = X25519(sha256("hushd.enc.v1" ‖ seed))      decrypts what others send you
 *
 * A receive address is "hushd1…": bech32m of pk (32 bytes) and the X25519 public key.
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bech32m } from "@scure/base";
import { be32, bytesToBigInt, concat, hashToField } from "./field.js";
import { poseidon } from "./poseidon.js";

const enc = new TextEncoder();
const PREFIX = "hushd";

export interface Identity {
  /** Spending key. Secret. */
  sk: bigint;
  /** Receive key = Poseidon(sk). */
  pk: bigint;
  /** X25519 private key. Secret. */
  encSecret: Uint8Array;
  /** X25519 public key. */
  encPublic: Uint8Array;
  /** "hushd1…" */
  address: string;
}

export interface ReceiveAddress {
  pk: bigint;
  encPublic: Uint8Array;
}

export function identityFromSeed(seed: Uint8Array): Identity {
  if (seed.length < 32) throw new RangeError("the seed must be at least 32 bytes");
  const sk = hashToField(concat(enc.encode("hushd.sk.v1"), seed));
  if (sk === 0n) throw new Error("degenerate seed");
  const pk = poseidon([sk]);
  const encSecret = sha256(concat(enc.encode("hushd.enc.v1"), seed));
  const encPublic = x25519.getPublicKey(encSecret);
  return { sk, pk, encSecret, encPublic, address: encodeAddress({ pk, encPublic }) };
}

/** A fresh random identity (agents, tests). Keep the seed: it is the identity. */
export function randomSeed(): Uint8Array {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return seed;
}

/** The seed behind a wallet signature: sha256 of the signature bytes. */
export function seedFromSignature(signature: Uint8Array): Uint8Array {
  return sha256(concat(enc.encode("hushd.seed.v1"), signature));
}

/** The exact message a NEAR wallet signs (NEP-413) to unlock the same Hushd identity on any device. */
export const SEED_MESSAGE = "Unlock my Hushd private balance. This signature never leaves this device and moves no funds.";

export function encodeAddress(a: ReceiveAddress): string {
  return bech32m.encode(PREFIX, bech32m.toWords(concat(be32(a.pk), a.encPublic)), false);
}

export function decodeAddress(address: string): ReceiveAddress {
  const { prefix, words } = bech32m.decode(address as `${string}1${string}`, false);
  if (prefix !== PREFIX) throw new Error("not a Hushd receive address");
  const bytes = bech32m.fromWords(words);
  if (bytes.length !== 64) throw new Error("not a Hushd receive address");
  return { pk: bytesToBigInt(bytes.slice(0, 32)), encPublic: bytes.slice(32) };
}

export function isAddress(s: string): boolean {
  try {
    decodeAddress(s);
    return true;
  } catch {
    return false;
  }
}
