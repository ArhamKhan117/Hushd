/// <reference path="./circomlibjs.d.ts" />
/**
 * Proofs for one named reader. Each proof binds a context: the reader's NEAR account,
 * an expiry, the network and the pool. A proof forwarded to someone else still names
 * the reader it was made for, and is refused after its expiry.
 *
 * - receipt: "I paid at least X of a token in this payment (or deal leg)".
 * - funds:   "I hold at least X of a token".
 * - volume:  "I delivered exactly X of a token across N desk deals".
 *
 * Shared as "hushdproof1" + base64url(JSON). Anyone checks it at /verify: the proof
 * off chain, then every chain fact through pool.verify_disclosure.
 */
import * as snarkjs from "snarkjs";
import type { Groth16Proof } from "snarkjs";
import { b64urlToUtf8, utf8ToB64url } from "./bytes.js";
import { assetField, proofContext } from "./field.js";
import type { Identity } from "./keys.js";
import type { HushdNetwork } from "./network.js";
import { nullifierOf, type Note } from "./note.js";
import { poolView, type DisclosureCheck } from "./pool.js";
import { prove, type ArtifactSource } from "./prove.js";
import { MerkleTree } from "./tree.js";

export type ProofKind = "receipt" | "funds" | "volume";

export interface ReaderProof {
  v: 1;
  kind: ProofKind;
  network: string;
  pool: string;
  /** NEAR account the proof is for, e.g. auditor.testnet. */
  reader: string;
  expiresAtMs: number;
  /** What the prover says it shows, in words (not part of the proof). */
  label?: string;
  token: string;
  proof: Groth16Proof;
  publicSignals: string[];
  /** volume: the (commitment, nullifier) of each leg. */
  legs?: [string, string][];
}

const PREFIX = "hushdproof1";
const S = (x: bigint | number) => x.toString();

const b64url = { enc: utf8ToB64url, dec: b64urlToUtf8 };

export function encodeProof(p: ReaderProof): string {
  return PREFIX + b64url.enc(JSON.stringify(p));
}

export function decodeProof(s: string): ReaderProof {
  const t = s.trim();
  if (!t.startsWith(PREFIX)) throw new Error("not a Hushd proof");
  const p = JSON.parse(b64url.dec(t.slice(PREFIX.length))) as ReaderProof;
  if (p.v !== 1 || !["receipt", "funds", "volume"].includes(p.kind)) throw new Error("unknown proof version or kind");
  return p;
}

interface Scope {
  net: HushdNetwork;
  reader: string;
  expiresAtMs: number;
  label?: string;
}

function context(kind: ProofKind, s: Scope): bigint {
  if (!s.net.pool) throw new Error(`no pool on ${s.net.id}`);
  return proofContext({ kind, network: s.net.id, pool: s.net.pool, reader: s.reader, expiresAtMs: s.expiresAtMs });
}

function wrap(kind: ProofKind, s: Scope, token: string, proven: { proof: Groth16Proof; publicSignals: string[] }, legs?: [string, string][]): ReaderProof {
  return {
    v: 1,
    kind,
    network: s.net.id,
    pool: s.net.pool!,
    reader: s.reader,
    expiresAtMs: s.expiresAtMs,
    ...(s.label ? { label: s.label } : {}),
    token,
    ...proven,
    ...(legs ? { legs } : {}),
  };
}

/** You paid `made` (a note you created for someone) with `paidWith` (a note you spent in that same call). */
export async function proveReceipt(
  src: ArtifactSource,
  id: Identity,
  s: Scope,
  made: Note,
  paidWith: Note,
  opts: { minAmount?: bigint; revealAmount?: boolean; showPayee?: boolean } = {},
): Promise<ReaderProof> {
  const reveal = opts.revealAmount ?? true;
  const showPayee = opts.showPayee ?? false;
  const input = {
    commitment: S(made.commitment),
    nullifier: S(nullifierOf(id.sk, paidWith.commitment)),
    asset: S(assetField(made.token)),
    minAmount: S(opts.minAmount ?? made.amount),
    reveal: reveal ? "1" : "0",
    shownAmount: S(reveal ? made.amount : 0n),
    showPayee: showPayee ? "1" : "0",
    shownPayee: S(showPayee ? made.pk : 0n),
    context: S(context("receipt", s)),
    payeePk: S(made.pk),
    blinding: S(made.blinding),
    amount: S(made.amount),
    inSk: S(id.sk),
    inBlinding: S(paidWith.blinding),
    inAmount: S(paidWith.amount),
  };
  return wrap("receipt", s, made.token, await prove(src, "receipt", input));
}

/** You hold at least `threshold` of `token`, backed by up to four of your notes. */
export async function proveFunds(src: ArtifactSource, id: Identity, s: Scope, tree: MerkleTree, notes: Note[], threshold: bigint): Promise<ReaderProof> {
  if (notes.length === 0 || notes.length > 4) throw new Error("a funds proof uses one to four notes");
  const token = notes[0]!.token;
  const slots = [...notes, ...Array(4 - notes.length).fill(null)] as (Note | null)[];
  const paths = slots.map((n) => (n ? tree.path(n.leafIndex ?? tree.indexOf(n.commitment)) : MerkleTree.zeroPath()));
  const input = {
    root: S(tree.root()),
    asset: S(assetField(token)),
    threshold: S(threshold),
    context: S(context("funds", s)),
    nullifier: slots.map((n) => (n ? S(nullifierOf(id.sk, n.commitment)) : "0")),
    used: slots.map((n) => (n ? "1" : "0")),
    sk: slots.map((n) => (n ? S(id.sk) : "0")),
    blinding: slots.map((n) => (n ? S(n.blinding) : "0")),
    amount: slots.map((n) => (n ? S(n.amount) : "0")),
    pathElements: paths.map((p) => p.pathElements.map(S)),
    pathIndices: paths.map((p) => p.pathIndices.map(S)),
  };
  return wrap("funds", s, token, await prove(src, "funds", input));
}

/** You delivered every `made[i]` (paid with `paidWith[i]`) as desk deal legs: the total and the count. */
export async function proveVolume(src: ArtifactSource, id: Identity, s: Scope, legs: { made: Note; paidWith: Note }[]): Promise<ReaderProof> {
  if (legs.length === 0 || legs.length > 16) throw new Error("a volume proof covers 1 to 16 legs");
  const token = legs[0]!.made.token;
  const { poseidon } = await import("./poseidon.js");
  const slots = Array.from({ length: 16 }, (_, i) => legs[i] ?? null);
  const pairs = slots.map((l) => (l ? [l.made.commitment, nullifierOf(id.sk, l.paidWith.commitment)] : [0n, 0n])) as [bigint, bigint][];
  let acc = 0n;
  for (const [c, n] of pairs) acc = poseidon([acc, c, n]);
  const total = legs.reduce((t, l) => t + l.made.amount, 0n);
  const input = {
    asset: S(assetField(token)),
    total: S(total),
    count: S(legs.length),
    legsHash: S(acc),
    context: S(context("volume", s)),
    used: slots.map((l) => (l ? "1" : "0")),
    payeePk: slots.map((l) => (l ? S(l.made.pk) : "0")),
    blinding: slots.map((l) => (l ? S(l.made.blinding) : "0")),
    amount: slots.map((l) => (l ? S(l.made.amount) : "0")),
    commitment: pairs.map(([c]) => S(c)),
    inSk: slots.map((l) => (l ? S(id.sk) : "0")),
    inBlinding: slots.map((l) => (l ? S(l.paidWith.blinding) : "0")),
    inAmount: slots.map((l) => (l ? S(l.paidWith.amount) : "0")),
    nullifier: pairs.map(([, n]) => S(n)),
  };
  return wrap("volume", s, token, await prove(src, "volume", input), pairs.slice(0, legs.length).map(([c, n]) => [S(c), S(n)]));
}

export interface Verdict {
  ok: boolean;
  /** What the proof shows, in plain words, when it holds. */
  shows: string[];
  problems: string[];
  chain?: DisclosureCheck;
}

const CONTEXT_INDEX: Record<ProofKind, number> = { receipt: 8, funds: 3, volume: 4 };

/**
 * Check a proof as its reader would. `vkeys` are the circuits' verification keys
 * (`/circuits/<kind>.vkey.json`). `asReader` is who is checking: a proof made for
 * someone else is flagged, never silently accepted.
 */
export async function verifyProof(net: HushdNetwork, p: ReaderProof, vkey: unknown, opts: { nowMs?: number; asReader?: string; onChain?: boolean } = {}): Promise<Verdict> {
  const problems: string[] = [];
  const shows: string[] = [];
  const now = opts.nowMs ?? Date.now();
  if (p.network !== net.id || p.pool !== net.pool) problems.push(`Made for ${p.pool} on ${p.network}, not this pool`);
  const ctx = proofContext({ kind: p.kind, network: p.network, pool: p.pool, reader: p.reader, expiresAtMs: p.expiresAtMs });
  if (p.publicSignals[CONTEXT_INDEX[p.kind]] !== ctx.toString()) problems.push("The reader or expiry was changed after proving");
  if (now > p.expiresAtMs) problems.push(`Expired on ${new Date(p.expiresAtMs).toISOString()}`);
  if (opts.asReader && opts.asReader !== p.reader) problems.push(`Made for ${p.reader}, not for ${opts.asReader}`);
  if (p.publicSignals[p.kind === "receipt" ? 2 : p.kind === "funds" ? 1 : 0] !== assetField(p.token).toString()) problems.push("The token named does not match the proof");
  if (!(await snarkjs.groth16.verify(vkey, p.publicSignals, p.proof))) problems.push("The zero-knowledge proof does not verify");

  let chain: DisclosureCheck | undefined;
  if (opts.onChain !== false && net.pool) {
    chain = await poolView.verifyDisclosure(net, p.kind, p.proof, p.publicSignals, p.legs);
    if (!chain.proof_valid) problems.push("The pool contract refuses the proof");
    problems.push(...chain.problems);
  }

  const sig = p.publicSignals;
  if (p.kind === "receipt") {
    shows.push(sig[4] === "1" ? `A payment of exactly ${sig[5]} (base units)` : `A payment of at least ${sig[3]} (base units)`);
    if (chain?.deal_ids[0]) shows.push(`It settled desk deal #${chain.deal_ids[0]}`);
    if (sig[6] === "1") shows.push(`To receive key ${BigInt(sig[7]!).toString(16).slice(0, 12)}…`);
  } else if (p.kind === "funds") {
    shows.push(`A balance of at least ${sig[2]} (base units), unspent right now`);
  } else {
    shows.push(`Delivered exactly ${sig[1]} (base units) across ${sig[2]} desk deal legs`);
  }
  return { ok: problems.length === 0, shows: problems.length === 0 ? shows : [], problems, ...(chain ? { chain } : {}) };
}
