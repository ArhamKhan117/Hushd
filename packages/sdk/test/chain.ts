/**
 * The pool, board and desk contracts' views and a relayer, in memory behind a stubbed fetch,
 * for tests that send real joinsplit proofs (checked by the circuit's verifying key).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import * as snarkjs from "snarkjs";
import type { PostView } from "../src/board.ts";
import { extHash, toHex } from "../src/field.ts";
import type { Identity } from "../src/keys.ts";
import { TESTNET, withOverrides } from "../src/network.ts";
import type { TransactRequest } from "../src/pool.ts";
import type { ArtifactSource } from "../src/prove.ts";
import { RelayerError, type RelayerClient } from "../src/relayer.ts";
import { MerkleTree } from "../src/tree.ts";
import { PrivateWallet, type WalletState } from "../src/wallet.ts";

const circuits = join(import.meta.dirname, "../../../app/public/circuits");
export const artifacts: ArtifactSource = { wasm: (n) => join(circuits, `${n}.wasm`), zkey: (n) => join(circuits, `${n}.zkey`) };
const vkey = JSON.parse(readFileSync(join(circuits, "joinsplit.vkey.json"), "utf8"));
export const TOKEN = "usdc.hushd.testnet";
export const NET = withOverrides(TESTNET, { rpc: ["http://rpc.test"], rpcSend: ["http://rpc.test"], pool: "pool.test", board: "board.test", desk: "desk.test" });

/** The contracts' views, in memory, behind a stubbed fetch. */
export class Chain {
  tree = new MerkleTree();
  roots = new Set<bigint>([this.tree.root()]);
  spends = new Map<bigint, [bigint, bigint]>();
  posts: string[] = [];
  /** The desk's deals by id, as `deal` answers them. */
  deals = new Map<number, unknown>();

  insert(c: bigint) {
    this.tree.insert(c);
    this.roots.add(this.tree.root());
  }

  view(contract: string, method: string, args: Record<string, string>): unknown {
    const leaves = Array.from({ length: this.tree.size }, (_, i) => toHex(this.tree.leaf(i)!));
    if (contract === "pool.test") {
      if (method === "next_leaf_index") return String(this.tree.size);
      if (method === "leaves") return leaves.slice(Number(args.from_index), Number(args.from_index) + Number(args.limit));
      if (method === "is_spent") return this.spends.has(BigInt(args.nullifier!));
      if (method === "spend_of") {
        const s = this.spends.get(BigInt(args.nullifier!));
        return s ? { outputs: s.map(toHex), deal_id: null, block_height: "1" } : null;
      }
    }
    if (contract === "board.test") {
      if (method === "count") return String(this.posts.length);
      if (method === "posts") {
        const from = Number(args.from_index);
        return this.posts.slice(from, from + Number(args.limit)).map((data, i): PostView => ({ index: String(from + i), data, tag: "note", block_height: "1", timestamp_ns: "0" }));
      }
    }
    if (contract === "desk.test" && method === "deal") return this.deals.get(Number(args.deal_id)) ?? null;
    throw new Error(`no view ${contract}.${method}`);
  }

  fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { params: { account_id: string; method_name: string; args_base64: string } };
    const p = body.params;
    const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8")) as Record<string, string>;
    const out = new TextEncoder().encode(JSON.stringify(this.view(p.account_id, p.method_name, args)));
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "hushd", result: { result: [...out], logs: [] } }));
  }) as typeof fetch;
}

/** The relayer: checks each proof as the real one does, then applies it to the chain. */
export function relayerFor(chain: Chain, hooks: { onTransact?: (r: TransactRequest) => void; refuse?: RelayerError } = {}) {
  const seen: TransactRequest[] = [];
  let n = 0;
  const relayer = {
    info: async () => ({ account: "relayer.test", network: "testnet", cashOutFeeBps: 0, allow: {}, lanes: 1 }),
    post: async (data: string) => {
      chain.posts.push(data);
      return { txHash: `post-${chain.posts.length}` };
    },
    transact: async (r: TransactRequest) => {
      hooks.onTransact?.(r);
      if (hooks.refuse) throw hooks.refuse;
      const a = r.args;
      const signals = [a.root, ...a.nullifiers, ...a.commitments, a.public_amount, "0", extHash().toString()];
      if (!(await snarkjs.groth16.verify(vkey, signals, r.proof))) throw new RelayerError("The proof does not verify for these arguments", 400);
      if (!chain.roots.has(BigInt(a.root))) throw new RelayerError("The proof names a root the pool does not know (sync and prove again)", 400);
      for (const x of a.nullifiers) if (chain.spends.has(BigInt(x))) throw new RelayerError("A note in this proof is already spent", 400);
      for (const x of a.nullifiers) chain.spends.set(BigInt(x), [BigInt(a.commitments[0]), BigInt(a.commitments[1])]);
      for (const c of a.commitments) chain.insert(BigInt(c));
      seen.push(r);
      return { txHash: `tx-${++n}` };
    },
  };
  return { relayer: relayer as unknown as RelayerClient, seen };
}

/** A wallet whose store keeps every state it saved, newest last. */
export function walletOf(id: Identity, relayer: RelayerClient, saved: WalletState[] = []) {
  return new PrivateWallet(NET, id, { artifacts, relayer, store: { load: async () => saved.at(-1) ?? null, save: async (s) => void saved.push(structuredClone(s)) } });
}

let realFetch: typeof fetch;
/** A fresh chain, answering every RPC call until the next one. */
export function useChain(): Chain {
  const chain = new Chain();
  realFetch ??= globalThis.fetch;
  globalThis.fetch = chain.fetch;
  return chain;
}
after(() => {
  if (realFetch) globalThis.fetch = realFetch;
});
