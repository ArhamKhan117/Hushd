/**
 * The pool's Poseidon Merkle tree, rebuilt client-side from its leaves in order.
 * Same rules as contracts/pool/src/tree.rs: depth 20, empty leaf 0, parent = Poseidon(left, right).
 */
import { poseidon } from "./poseidon.js";

export const LEVELS = 20;

export interface MerklePath {
  pathElements: bigint[];
  pathIndices: number[];
}

export class MerkleTree {
  readonly zeros: bigint[];
  /** layers[0] are the leaves, layers[LEVELS] holds the root. */
  private layers: bigint[][];
  private index = new Map<bigint, number>();

  constructor(leaves: readonly bigint[] = []) {
    this.zeros = [0n];
    for (let i = 0; i < LEVELS; i++) this.zeros.push(poseidon([this.zeros[i]!, this.zeros[i]!]));
    this.layers = Array.from({ length: LEVELS + 1 }, () => [] as bigint[]);
    for (const l of leaves) this.insert(l);
  }

  get size(): number {
    return this.layers[0]!.length;
  }

  insert(leaf: bigint): number {
    const i = this.layers[0]!.length;
    this.layers[0]!.push(leaf);
    if (!this.index.has(leaf)) this.index.set(leaf, i);
    let pos = i;
    for (let d = 0; d < LEVELS; d++) {
      const parent = pos >> 1;
      const left = this.layers[d]![parent * 2]!;
      const right = this.layers[d]![parent * 2 + 1] ?? this.zeros[d]!;
      this.layers[d + 1]![parent] = poseidon([left, right]);
      pos = parent;
    }
    return i;
  }

  root(): bigint {
    return this.size === 0 ? this.zeros[LEVELS]! : this.layers[LEVELS]![0]!;
  }

  indexOf(commitment: bigint): number {
    return this.index.get(commitment) ?? -1;
  }

  leaf(i: number): bigint | undefined {
    return this.layers[0]![i];
  }

  path(i: number): MerklePath {
    if (i < 0 || i >= this.size) throw new RangeError("no such leaf");
    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];
    let pos = i;
    for (let d = 0; d < LEVELS; d++) {
      pathElements.push(this.layers[d]![pos ^ 1] ?? this.zeros[d]!);
      pathIndices.push(pos & 1);
      pos >>= 1;
    }
    return { pathElements, pathIndices };
  }

  /** A copy that grows on its own: a second wallet can load new leaves into it without touching this one. */
  clone(): MerkleTree {
    const t = new MerkleTree();
    t.layers = this.layers.map((l) => [...l]);
    t.index = new Map(this.index);
    return t;
  }

  static zeroPath(): MerklePath {
    return { pathElements: Array(LEVELS).fill(0n), pathIndices: Array(LEVELS).fill(0) };
  }
}
