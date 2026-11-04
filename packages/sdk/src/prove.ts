/// <reference path="./circomlibjs.d.ts" />
/**
 * Groth16 proving for the four Hushd circuits, in Node or the browser.
 * Artifacts (witness generator .wasm, proving key .zkey) come from `circuits` and are
 * published at /circuits/<name>.{wasm,zkey} by the app.
 */
import * as snarkjs from "snarkjs";
import type { Groth16Proof } from "snarkjs";
import { assetField, extHash, type ExtData } from "./field.js";
import type { Identity } from "./keys.js";
import { dummyNote, type Note } from "./note.js";
import { MerkleTree, type MerklePath } from "./tree.js";

export type CircuitName = "joinsplit" | "receipt" | "funds" | "volume";

/** Where to load circuit artifacts from: a URL base in the browser, a directory in Node. */
export interface ArtifactSource {
  wasm(name: CircuitName): string | Uint8Array | Promise<string | Uint8Array>;
  zkey(name: CircuitName): string | Uint8Array | Promise<string | Uint8Array>;
}

export function artifactsAt(base: string): ArtifactSource {
  const b = base.replace(/\/$/, "");
  return { wasm: (n) => `${b}/${n}.wasm`, zkey: (n) => `${b}/${n}.zkey` };
}

export interface Proven {
  proof: Groth16Proof;
  publicSignals: string[];
}

export async function prove(src: ArtifactSource, name: CircuitName, input: Record<string, unknown>): Promise<Proven> {
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, await src.wasm(name), await src.zkey(name));
  return { proof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c }, publicSignals };
}

const S = (x: bigint | number) => x.toString();

export interface JoinsplitPlan {
  /** One or two of your notes (same token), each with leafIndex set. */
  inputs: Note[];
  /** Exactly two outputs (pad with a zero note); amounts must balance. */
  outputs: [Note, Note];
  /** Cash out amount (0 for a private send or a swap leg). */
  publicAmount?: bigint;
  /** extHash: from `ext` for sends and cash outs, or a swap binding. */
  ext?: ExtData;
  binding?: bigint;
}

export interface JoinsplitArgs extends Proven {
  root: string;
  nullifiers: [string, string];
  commitments: [string, string];
}

/** Build the joinsplit witness and prove it. The tree must hold every input. */
export async function proveJoinsplit(src: ArtifactSource, id: Identity, tree: MerkleTree, plan: JoinsplitPlan): Promise<JoinsplitArgs> {
  const token = plan.outputs[0].token;
  const inputs = [...plan.inputs];
  if (inputs.length === 0 || inputs.length > 2) throw new Error("a joinsplit spends one or two notes");
  while (inputs.length < 2) inputs.push(dummyNote(id, token));
  for (const n of [...inputs, ...plan.outputs]) if (n.token !== token) throw new Error("a joinsplit moves one token");
  const publicAmount = plan.publicAmount ?? 0n;
  const inSum = inputs.reduce((s, n) => s + n.amount, 0n);
  const outSum = plan.outputs.reduce((s, n) => s + n.amount, 0n);
  if (inSum !== outSum + publicAmount) throw new Error("inputs and outputs do not balance");

  const paths: MerklePath[] = inputs.map((n) => {
    if (n.amount === 0n) return MerkleTree.zeroPath();
    const i = n.leafIndex ?? tree.indexOf(n.commitment);
    if (i < 0 || tree.leaf(i) !== n.commitment) throw new Error("a note to spend is not in the tree yet");
    return tree.path(i);
  });
  const nullifiers = inputs.map((n) => n.nullifier ?? (() => { throw new Error("spend only notes you own"); })());
  const ext = plan.binding ?? extHash(plan.ext);
  const root = tree.root();
  const input = {
    root: S(root),
    nullifier: nullifiers.map(S),
    commitment: plan.outputs.map((o) => S(o.commitment)),
    publicAmount: S(publicAmount),
    publicAsset: S(publicAmount === 0n ? 0n : assetField(token)),
    extHash: S(ext),
    asset: S(assetField(token)),
    inSk: inputs.map(() => S(id.sk)),
    inBlinding: inputs.map((n) => S(n.blinding)),
    inAmount: inputs.map((n) => S(n.amount)),
    pathElements: paths.map((p) => p.pathElements.map(S)),
    pathIndices: paths.map((p) => p.pathIndices.map(S)),
    outPk: plan.outputs.map((o) => S(o.pk)),
    outBlinding: plan.outputs.map((o) => S(o.blinding)),
    outAmount: plan.outputs.map((o) => S(o.amount)),
  };
  const proven = await prove(src, "joinsplit", input);
  return {
    ...proven,
    root: S(root),
    nullifiers: [S(nullifiers[0]!), S(nullifiers[1]!)],
    commitments: [S(plan.outputs[0].commitment), S(plan.outputs[1].commitment)],
  };
}
