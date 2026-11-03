/**
 * The Hushd note scheme in plain JavaScript: keys, commitments, nullifiers, the
 * Merkle tree and the hashes the pool binds. Mirrors contracts/pool and the
 * circuits exactly; the SDK's version is this file with types.
 */
import { createHash } from "node:crypto";
import { buildPoseidon } from "circomlibjs";

export const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const LEVELS = 20;

let poseidonP;
export async function poseidon() {
  poseidonP ??= buildPoseidon();
  const p = await poseidonP;
  return (inputs) => p.F.toObject(p(inputs.map((x) => BigInt(x))));
}

/** sha256 with the top byte cleared, read big-endian: a 248-bit field element. */
export function hashToField(bytes) {
  const h = createHash("sha256").update(bytes).digest();
  h[0] = 0;
  return BigInt("0x" + h.toString("hex"));
}

export const assetField = (token) => hashToField(Buffer.from("hushd.asset.v1:" + token, "utf8"));

export const be32 = (x) => Buffer.from(BigInt(x).toString(16).padStart(64, "0"), "hex");
const le16 = (x) => {
  const b = Buffer.alloc(16);
  let n = BigInt(x);
  for (let i = 0; i < 16; i++) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return b;
};
const le64 = (x) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(x));
  return b;
};

/** Must match ExtData::hash in contracts/pool/src/lib.rs. */
export function extHash({ recipient = null, relayer = null, fee = 0n, refundInner = null, memo = null } = {}) {
  const parts = [Buffer.from("hushd.ext.v1")];
  for (const a of [recipient, relayer]) {
    const s = Buffer.from(a ?? "", "utf8");
    parts.push(Buffer.from([s.length]), s);
  }
  parts.push(le16(fee), refundInner === null ? Buffer.alloc(32) : be32(refundInner));
  const m = Buffer.from(memo ?? "", "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(m.length);
  parts.push(len, m);
  return hashToField(Buffer.concat(parts));
}

/** Must match swap_ext_hash in contracts/pool/src/lib.rs. */
export function swapExtHash(dealId, aOut, bOut) {
  return hashToField(Buffer.concat([Buffer.from("hushd.swap.v1"), le64(dealId), ...[...aOut, ...bOut].map(be32)]));
}

export async function noteScheme() {
  const H = await poseidon();
  const receiveKey = (sk) => H([sk]);
  const inner = (pk, blinding) => H([pk, blinding]);
  const commitment = (innerValue, amount, asset) => H([innerValue, amount, asset]);
  const nullifier = (sk, c) => H([sk, c]);
  /** A note owned by sk. */
  const owned = (sk, blinding, amount, asset) => {
    const pk = receiveKey(sk);
    const c = commitment(inner(pk, blinding), amount, asset);
    return { sk, pk, blinding, amount: BigInt(amount), asset, commitment: c, nullifier: nullifier(sk, c) };
  };
  /** A note for someone else's receive key. */
  const forKey = (pk, blinding, amount, asset) => ({ pk, blinding, amount: BigInt(amount), asset, commitment: commitment(inner(pk, blinding), amount, asset) });
  return { H, receiveKey, inner, commitment, nullifier, owned, forKey };
}

/** Incremental Poseidon tree, same as contracts/pool/src/tree.rs, keeping every leaf for paths. */
export class Tree {
  constructor(H) {
    this.H = H;
    this.zeros = [0n];
    for (let i = 0; i < LEVELS; i++) this.zeros.push(H([this.zeros[i], this.zeros[i]]));
    this.leaves = [];
  }
  insert(leaf) {
    this.leaves.push(BigInt(leaf));
    return this.leaves.length - 1;
  }
  layers() {
    const layers = [this.leaves.slice()];
    for (let d = 0; d < LEVELS; d++) {
      const prev = layers[d];
      const next = [];
      for (let i = 0; i < prev.length; i += 2) next.push(this.H([prev[i], i + 1 < prev.length ? prev[i + 1] : this.zeros[d]]));
      layers.push(next);
    }
    return layers;
  }
  root() {
    if (this.leaves.length === 0) return this.zeros[LEVELS];
    return this.layers()[LEVELS][0];
  }
  path(index) {
    const layers = this.layers();
    const pathElements = [];
    const pathIndices = [];
    let i = index;
    for (let d = 0; d < LEVELS; d++) {
      const sib = i ^ 1;
      pathElements.push(sib < layers[d].length ? layers[d][sib] : this.zeros[d]);
      pathIndices.push(i & 1);
      i >>= 1;
    }
    return { pathElements, pathIndices };
  }
  indexOf(leaf) {
    return this.leaves.indexOf(BigInt(leaf));
  }
}

export const randomField = () => {
  const b = createHash("sha256").update(Math.random().toString() + process.hrtime.bigint()).digest();
  return BigInt("0x" + b.toString("hex")) % R;
};
