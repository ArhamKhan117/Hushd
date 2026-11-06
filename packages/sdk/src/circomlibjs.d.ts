declare module "circomlibjs" {
  interface Field {
    toObject(x: unknown): bigint;
  }
  interface PoseidonFn {
    (inputs: bigint[]): unknown;
    F: Field;
  }
  export function buildPoseidon(): Promise<PoseidonFn>;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasm: string | Uint8Array, zkey: string | Uint8Array): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    verify(vkey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
  };
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol?: string;
    curve?: string;
  }
}

declare module "ffjavascript";
