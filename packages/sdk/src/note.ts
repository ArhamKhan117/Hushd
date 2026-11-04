/**
 * Notes: the private balance is a set of notes in the pool's tree.
 *
 *   inner      = Poseidon(pk, blinding)
 *   commitment = Poseidon(inner, amount, asset)
 *   nullifier  = Poseidon(sk, commitment)
 */
import { assetField, randomField } from "./field.js";
import type { Identity } from "./keys.js";
import { poseidon } from "./poseidon.js";

export interface Note {
  /** NEP-141 token account id. */
  token: string;
  amount: bigint;
  blinding: bigint;
  /** Owner's receive key. */
  pk: bigint;
  inner: bigint;
  commitment: bigint;
  /** Position in the pool's tree, once known. */
  leafIndex?: number;
  /** Set for notes you own. */
  nullifier?: bigint;
}

export function noteInner(pk: bigint, blinding: bigint): bigint {
  return poseidon([pk, blinding]);
}

export function noteCommitment(inner: bigint, amount: bigint, token: string): bigint {
  return poseidon([inner, amount, assetField(token)]);
}

export function nullifierOf(sk: bigint, commitment: bigint): bigint {
  return poseidon([sk, commitment]);
}

/** A note for receive key `pk` (yours or someone else's). */
export function makeNote(pk: bigint, token: string, amount: bigint, blinding: bigint = randomField()): Note {
  if (amount < 0n || amount >= 1n << 128n) throw new RangeError("amount out of range");
  const inner = noteInner(pk, blinding);
  return { token, amount, blinding, pk, inner, commitment: noteCommitment(inner, amount, token) };
}

/** Attach the nullifier to a note you own. */
export function own(note: Note, id: Identity): Note {
  if (note.pk !== id.pk) throw new Error("this note belongs to another receive key");
  return { ...note, nullifier: nullifierOf(id.sk, note.commitment) };
}

/** A zero-value input that pads a joinsplit to two inputs; never in the tree. */
export function dummyNote(id: Identity, token: string): Note {
  return own(makeNote(id.pk, token, 0n), id);
}
