/**
 * BN254 scalar field helpers and the hashes the pool contract binds.
 * Every function here has a twin in contracts/pool and must stay byte-identical.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** The BN254 scalar field modulus r. */
export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const enc = new TextEncoder();

export function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** 32 bytes, big-endian. */
export function be32(x: bigint): Uint8Array {
  if (x < 0n || x >= 1n << 256n) throw new RangeError("value does not fit 32 bytes");
  const out = new Uint8Array(32);
  let n = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function le(x: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let n = x;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new RangeError(`value does not fit ${bytes} bytes`);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** sha256 with the top byte cleared, read big-endian: a 248-bit field element. */
export function hashToField(data: Uint8Array): bigint {
  const h = sha256(data);
  h[0] = 0;
  return bytesToBigInt(h);
}

/** The field id of a NEP-141 token: sha256("hushd.asset.v1:" + account id), top byte cleared. */
export function assetField(token: string): bigint {
  return hashToField(enc.encode(`hushd.asset.v1:${token}`));
}

export function toHex(x: bigint): string {
  return `0x${x.toString(16).padStart(64, "0")}`;
}

/** Decimal or 0x hex, below r. */
export function parseField(s: string | bigint): bigint {
  const n = typeof s === "bigint" ? s : BigInt(s);
  if (n < 0n || n >= R) throw new RangeError("not a field element below r");
  return n;
}

export function randomField(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return bytesToBigInt(b) % R;
}

export interface ExtData {
  recipient?: string | null;
  relayer?: string | null;
  fee?: bigint;
  /** `inner` of the note the pool inserts if a cash out cannot be paid. */
  refundInner?: bigint | null;
  memo?: string | null;
}

/**
 * The pool's ExtData::hash: "hushd.ext.v1" ‖ len ‖ recipient ‖ len ‖ relayer ‖ fee (u128 LE)
 * ‖ refund_inner (32 BE) ‖ memo length (u32 LE) ‖ memo, sha256, cut to 248 bits.
 */
export function extHash(ext: ExtData = {}): bigint {
  const parts: Uint8Array[] = [enc.encode("hushd.ext.v1")];
  for (const a of [ext.recipient, ext.relayer]) {
    const s = enc.encode(a ?? "");
    if (s.length > 64) throw new RangeError("account id too long");
    parts.push(Uint8Array.of(s.length), s);
  }
  parts.push(le(ext.fee ?? 0n, 16), ext.refundInner == null ? new Uint8Array(32) : be32(ext.refundInner));
  const memo = enc.encode(ext.memo ?? "");
  parts.push(le(BigInt(memo.length), 4), memo);
  return hashToField(concat(...parts));
}

/** The binding both legs of a swap share: "hushd.swap.v1" ‖ deal id (u64 LE) ‖ four outputs (32 BE). */
export function swapExtHash(dealId: bigint, legAOutputs: readonly [bigint, bigint], legBOutputs: readonly [bigint, bigint]): bigint {
  return hashToField(concat(enc.encode("hushd.swap.v1"), le(dealId, 8), ...[...legAOutputs, ...legBOutputs].map(be32)));
}

/**
 * The context a reader proof binds: who it is for, until when, on which network and pool.
 * sha256("hushd.proof.v1" ‖ kind ‖ network ‖ pool ‖ reader ‖ expiry), each string length-prefixed, cut to 248 bits.
 */
export function proofContext(p: { kind: string; network: string; pool: string; reader: string; expiresAtMs: number }): bigint {
  const parts: Uint8Array[] = [enc.encode("hushd.proof.v1")];
  for (const s of [p.kind, p.network, p.pool, p.reader]) {
    const b = enc.encode(s);
    parts.push(Uint8Array.of(b.length), b);
  }
  parts.push(le(BigInt(p.expiresAtMs), 8));
  return hashToField(concat(...parts));
}
