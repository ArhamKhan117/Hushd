/// <reference path="./circomlibjs.d.ts" />
/**
 * The pool contract: reads, and the exact arguments for each call. Signing is the
 * caller's (a wallet for shields, the relayer for everything private).
 */
import type { Groth16Proof } from "snarkjs";
import { toHex, type ExtData } from "./field.js";
import type { HushdNetwork } from "./network.js";
import type { Note } from "./note.js";
import type { JoinsplitArgs } from "./prove.js";
import { view } from "./rpc.js";
import { MerkleTree } from "./tree.js";

export interface AssetView {
  token: string;
  field: string;
  limits: { per_deposit: string; total: string };
  held: string;
}

export interface SpendView {
  outputs: [string, string];
  deal_id: string | null;
  block_height: string;
}

export interface PoolStats {
  shields: number;
  transfers: number;
  cash_outs: number;
  swaps: number;
  refunds: number;
}

export interface DisclosureCheck {
  proof_valid: boolean;
  chain_valid: boolean;
  problems: string[];
  token: string | null;
  deal_ids: (string | null)[];
}

function pool(net: HushdNetwork): string {
  if (!net.pool) throw new Error(`no Hushd pool on ${net.id}`);
  return net.pool;
}

export const poolView = {
  root: (net: HushdNetwork) => view<string>(net, pool(net), "get_root"),
  isKnownRoot: (net: HushdNetwork, root: bigint) => view<boolean>(net, pool(net), "is_known_root", { root: toHex(root) }),
  nextLeafIndex: async (net: HushdNetwork) => Number(await view<string>(net, pool(net), "next_leaf_index")),
  leaves: (net: HushdNetwork, from: number, limit: number) => view<string[]>(net, pool(net), "leaves", { from_index: String(from), limit }),
  isSpent: (net: HushdNetwork, nullifier: bigint) => view<boolean>(net, pool(net), "is_spent", { nullifier: toHex(nullifier) }),
  spendOf: (net: HushdNetwork, nullifier: bigint) => view<SpendView | null>(net, pool(net), "spend_of", { nullifier: toHex(nullifier) }),
  assets: (net: HushdNetwork) => view<AssetView[]>(net, pool(net), "assets"),
  stats: (net: HushdNetwork) => view<PoolStats>(net, pool(net), "stats"),
  config: (net: HushdNetwork) => view<Record<string, unknown>>(net, pool(net), "config"),
  verifyDisclosure: (net: HushdNetwork, kind: "receipt" | "funds" | "volume", proof: Groth16Proof, publicInputs: string[], legs?: [string, string][]) =>
    view<DisclosureCheck>(net, pool(net), "verify_disclosure", { kind, proof, public_inputs: publicInputs, legs: legs ?? null }),
};

/** Rebuild the whole tree from the pool's stored leaves, `pageSize` at a time. */
export async function loadTree(net: HushdNetwork, pageSize = 500, from?: MerkleTree): Promise<MerkleTree> {
  const tree = from ?? new MerkleTree();
  const total = await poolView.nextLeafIndex(net);
  while (tree.size < total) {
    const page = await poolView.leaves(net, tree.size, pageSize);
    if (page.length === 0) break;
    for (const l of page) tree.insert(BigInt(l));
  }
  return tree;
}

/** `ft_transfer_call` arguments that shield `note` (sent to the token contract, 1 yocto, ~100 Tgas). */
export function shieldCall(net: HushdNetwork, note: Note) {
  return {
    contract: note.token,
    method: "ft_transfer_call",
    args: { receiver_id: pool(net), amount: note.amount.toString(), memo: null, msg: JSON.stringify({ inner: toHex(note.inner) }) },
    gas: "120000000000000",
    deposit: "1",
  };
}

export interface TransactRequest {
  proof: Groth16Proof;
  args: {
    root: string;
    nullifiers: [string, string];
    commitments: [string, string];
    public_amount: string;
    token: string | null;
    ext: { recipient: string | null; relayer: string | null; fee: string; refund_inner: string | null; memo: string | null };
  };
}

/** `transact` arguments for a proven joinsplit (sent by the relayer with ~0.01 NEAR for storage). */
export function transactRequest(j: JoinsplitArgs, publicAmount: bigint, token: string | null, ext: ExtData = {}): TransactRequest {
  return {
    proof: j.proof,
    args: {
      root: j.root,
      nullifiers: j.nullifiers,
      commitments: j.commitments,
      public_amount: publicAmount.toString(),
      token: publicAmount === 0n ? null : token,
      ext: {
        recipient: ext.recipient ?? null,
        relayer: ext.relayer ?? null,
        fee: (ext.fee ?? 0n).toString(),
        refund_inner: ext.refundInner == null ? null : toHex(ext.refundInner),
        memo: ext.memo ?? null,
      },
    },
  };
}

/** One leg of a swap as `desk.settle` forwards it to `pool.settle_swap`. */
export function swapLeg(j: JoinsplitArgs) {
  return { proof: j.proof, root: j.root, nullifiers: j.nullifiers, commitments: j.commitments };
}
