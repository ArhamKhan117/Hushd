/// <reference path="./circomlibjs.d.ts" />
/**
 * Poseidon over BN254 with circomlib's parameters: the circuits' hash. Load once with
 * `loadPoseidon()`; after that `poseidon()` is synchronous.
 */
import { buildPoseidon } from "circomlibjs";

type Built = Awaited<ReturnType<typeof buildPoseidon>>;
let built: Built | undefined;
let loading: Promise<Built> | undefined;

export async function loadPoseidon(): Promise<void> {
  loading ??= buildPoseidon();
  built = await loading;
}

export function poseidon(inputs: readonly bigint[]): bigint {
  if (!built) throw new Error("call loadPoseidon() first");
  return built.F.toObject(built(inputs.map((x) => BigInt(x)))) as bigint;
}
