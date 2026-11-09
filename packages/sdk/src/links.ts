/**
 * Claim links: pay anyone as a link. A link is a one-time Hushd identity (32 random bytes)
 * and the opening of one note the payer made for it, carried after the # of a URL, which a
 * browser never sends to any server. Claiming spends that note into a fresh note for the
 * claimer's own receive key, made on the claimer's device, so after a claim the payer
 * cannot spend it back. The relayer sends the claim: the claimer needs no gas.
 *
 *   code  = base64url( version 0x01 ‖ seed (32) ‖ blinding (32, BE) ‖ n (1) ‖ amount (n, BE)
 *                      ‖ m (1) ‖ token (m, UTF-8) ‖ check (4) )
 *   check = sha256("hushd.link" ‖ every byte before it), first 4 bytes
 *
 * The check covers the version byte and stays the same across versions, so a damaged link
 * is told apart from one a newer version made.
 *
 * The payer keeps each link in its wallet's encrypted store, saved before the payment goes
 * out, and can take back one nobody has claimed (a claim to itself).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
import { bytesToHex, hexToBytes } from "./bytes.js";
import { be32, bytesToBigInt, concat, R, randomField } from "./field.js";
import { identityFromSeed, randomSeed, type Identity } from "./keys.js";
import type { HushdNetwork, TokenInfo } from "./network.js";
import { makeNote, own, type Note } from "./note.js";
import { loadTree, poolView } from "./pool.js";
import { loadPoseidon } from "./poseidon.js";
import type { ArtifactSource } from "./prove.js";
import { RelayerError, type RelayerClient } from "./relayer.js";
import { MerkleTree } from "./tree.js";
import { PrivateWallet, type SendResult, type StoredLink } from "./wallet.js";

export const LINK_VERSION = 1;

/** The one answer for a link whose note is spent, whether claimed or taken back: a visitor learns nothing more. */
export const ALREADY_CLAIMED = "This link was already claimed.";
export const NOT_IN_POOL = "This link's payment is not in the pool. If it was sent a moment ago, try again shortly.";
const MALFORMED = "This is not a complete Hushd claim link. Copy all of it and try again.";

const DOMAIN = new TextEncoder().encode("hushd.link");
const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A claim link: the one-time seed, and the opening of the note paid to it. */
export interface Link {
  seed: Uint8Array;
  token: string;
  amount: bigint;
  blinding: bigint;
}

export class LinkError extends Error {}

/** A fresh link for `amount` of `token` (nothing is paid yet). */
export function newLink(token: string, amount: bigint): Link {
  if (amount <= 0n || amount >= 1n << 128n) throw new RangeError("a link pays an amount above zero");
  if (!ACCOUNT_ID.test(token)) throw new RangeError("not a token account id");
  return { seed: randomSeed(), token, amount, blinding: randomField() };
}

function checkBytes(body: Uint8Array): Uint8Array {
  return sha256(concat(DOMAIN, body)).slice(0, 4);
}

function amountBytes(x: bigint): Uint8Array {
  const out: number[] = [];
  for (let n = x; n > 0n; n >>= 8n) out.unshift(Number(n & 0xffn));
  return Uint8Array.from(out);
}

/** The link as a URL-safe code (base64url, no padding). */
export function encodeLink(link: Link): string {
  if (link.seed.length !== 32) throw new RangeError("a link seed is 32 bytes");
  if (link.amount <= 0n || link.amount >= 1n << 128n) throw new RangeError("a link pays an amount above zero");
  if (link.blinding < 0n || link.blinding >= R) throw new RangeError("the blinding is not a field element");
  const token = new TextEncoder().encode(link.token);
  if (!ACCOUNT_ID.test(link.token)) throw new RangeError("not a token account id");
  const amount = amountBytes(link.amount);
  const body = concat(Uint8Array.of(LINK_VERSION), link.seed, be32(link.blinding), Uint8Array.of(amount.length), amount, Uint8Array.of(token.length), token);
  return base64urlnopad.encode(concat(body, checkBytes(body)));
}

/** Read a link code; throws a LinkError, in words a person can act on, for anything else. */
export function decodeLink(code: string): Link {
  let bytes: Uint8Array;
  try {
    bytes = base64urlnopad.decode(code);
  } catch {
    throw new LinkError(MALFORMED);
  }
  if (bytes.length < 1 + 4) throw new LinkError(MALFORMED);
  const body = bytes.slice(0, -4);
  const check = bytes.slice(-4);
  if (!checkBytes(body).every((b, i) => b === check[i])) throw new LinkError(MALFORMED);
  if (body[0] !== LINK_VERSION) throw new LinkError("This claim link was made by a newer version of Hushd.");
  let at = 1;
  const take = (n: number) => {
    if (at + n > body.length) throw new LinkError(MALFORMED);
    const out = body.slice(at, at + n);
    at += n;
    return out;
  };
  const seed = take(32);
  const blinding = bytesToBigInt(take(32));
  const amountLen = take(1)[0]!;
  if (amountLen === 0 || amountLen > 16) throw new LinkError(MALFORMED);
  const amountRaw = take(amountLen);
  // one encoding per amount: no leading zero byte
  if (amountRaw[0] === 0) throw new LinkError(MALFORMED);
  const amount = bytesToBigInt(amountRaw);
  const tokenLen = take(1)[0]!;
  let token: string;
  try {
    token = new TextDecoder("utf-8", { fatal: true }).decode(take(tokenLen));
  } catch (e) {
    if (e instanceof LinkError) throw e;
    throw new LinkError(MALFORMED);
  }
  if (at !== body.length || blinding >= R || !ACCOUNT_ID.test(token)) throw new LinkError(MALFORMED);
  return { seed, token, amount, blinding };
}

/** A whole claim URL (anything up to the #) or the bare code. */
export function parseLink(input: string): Link {
  const s = input.trim();
  return decodeLink(s.slice(s.lastIndexOf("#") + 1));
}

/** The URL to share: the app's claim page, with the code after the #. */
export function linkUrl(appOrigin: string, link: Link): string {
  return `${appOrigin.replace(/\/$/, "")}/app/claim#${encodeLink(link)}`;
}

export function linkIdentity(link: Link): Identity {
  return identityFromSeed(link.seed);
}

/** The note paid to the link, with its nullifier. */
export function linkNote(link: Link): Note {
  const id = linkIdentity(link);
  return own(makeNote(id.pk, link.token, link.amount, link.blinding), id);
}

/** The listed token a link pays (by its exact account id), or a LinkError for one this network does not list. */
export function linkToken(net: HushdNetwork, link: Link): TokenInfo {
  const t = net.tokens.find((x) => x.id === link.token);
  if (!t) throw new LinkError(`This link pays a token Hushd does not list on NEAR ${net.id}.`);
  return t;
}

export type LinkCheck = { state: "ready"; tree: MerkleTree; leafIndex: number } | { state: "claimed" | "missing" };

/**
 * What the pool says about a link: its note is in the tree and unspent ("ready"), spent
 * ("claimed", which also covers taken back), or not in the pool ("missing"). Only a "ready"
 * link's amount and token are real: the pool holds a note with exactly that opening.
 */
export async function checkLink(net: HushdNetwork, link: Link, tree?: MerkleTree): Promise<LinkCheck> {
  linkToken(net, link);
  // a visitor's page may check a link before anything else has hashed
  await loadPoseidon();
  const note = linkNote(link);
  const t = await loadTree(net, 500, tree);
  const leafIndex = t.indexOf(note.commitment);
  if (leafIndex < 0) return { state: "missing" };
  if (await poolView.isSpent(net, note.nullifier!)) return { state: "claimed" };
  return { state: "ready", tree: t, leafIndex };
}

export interface ClaimOptions {
  /** The wallet claiming: the new note belongs to its receive key. */
  to: PrivateWallet;
  artifacts: ArtifactSource;
  relayer: RelayerClient;
  /** The tree a `checkLink` just loaded, to sync on from. */
  tree?: MerkleTree;
  /** Sealed to the claimer with the new note. */
  memo?: string;
  /** Runs once the claim is proven, just before it goes out, after the new note is on record in `to`. */
  beforeSend?: (payment: Note) => Promise<void>;
}

/**
 * Claim a link into `to`: a throwaway wallet for the link's identity spends the link note
 * into a note for `to`'s receive key, through the relayer (no gas, no fee). The new note's
 * blinding is made here, on the claimer's side, and the note is sealed to the claimer on the
 * board, so its seed alone recovers it anywhere.
 */
export async function claimLink(link: Link, o: ClaimOptions): Promise<SendResult> {
  linkToken(o.to.net, link);
  const w = new PrivateWallet(o.to.net, linkIdentity(link), { artifacts: o.artifacts, relayer: o.relayer, ...(o.tree ? { tree: o.tree } : {}) });
  w.track(linkNote(link));
  // the link carries its note's opening: no board scan
  await w.sync({ board: false });
  if (w.pending().length > 0) throw new LinkError(NOT_IN_POOL);
  if (w.spendable(link.token).length === 0) throw new LinkError(ALREADY_CLAIMED);
  const payment = makeNote(o.to.id.pk, link.token, link.amount);
  const memo = o.memo ?? "Claimed from a link";
  try {
    const r = await w.pay(payment, {
      word: { to: o.to.id, memo },
      beforeSend: async () => {
        // on record before the claim goes out: if it lands while this device is gone, a sync still finds it
        await o.to.expect(payment, { memo });
        await o.beforeSend?.(payment);
      },
    });
    o.to.track(payment);
    return r;
  } catch (e) {
    // someone else's claim (or a take back) reached the pool first
    if (/already spent/i.test((e as Error).message)) throw new LinkError(ALREADY_CLAIMED);
    throw e;
  }
}

export interface PaidLink {
  link: Link;
  code: string;
  txHash: string;
}

function storedLink(link: Link, atMs: number): StoredLink {
  return { seed: bytesToHex(link.seed), token: link.token, amount: link.amount.toString(), blinding: link.blinding.toString(), atMs };
}

export function linkFromStored(s: StoredLink): Link {
  return { seed: hexToBytes(s.seed), token: s.token, amount: BigInt(s.amount), blinding: BigInt(s.blinding) };
}

/**
 * Pay `amount` of `token` from `wallet` as a link. The link is in the wallet's encrypted
 * store before the payment goes out, so a crash mid-send cannot lose it.
 */
export async function payAsLink(wallet: PrivateWallet, token: string, amount: bigint): Promise<PaidLink> {
  const link = newLink(token, amount);
  const stored = storedLink(link, Date.now());
  let saved = false;
  try {
    // no board post: the link itself carries the note's opening
    const r = await wallet.pay(makeNote(linkIdentity(link).pk, token, amount, link.blinding), {
      beforeSend: async () => {
        await wallet.rememberLink(stored);
        saved = true;
      },
    });
    await wallet.rememberLink({ ...stored, txHash: r.txHash });
    return { link, code: encodeLink(link), txHash: r.txHash };
  } catch (e) {
    // the relayer refused it, so nothing went out and the link was never paid
    if (saved && e instanceof RelayerError && e.status >= 400 && e.status < 500) await wallet.forgetLink(stored.seed);
    throw e;
  }
}

/** Where a paid link stands. "sending": its payment has not shown in the pool yet; "not sent": it never did. */
export type LinkState = "sending" | "waiting" | "claimed" | "taken back" | "not sent";

export interface SentLink {
  link: Link;
  code: string;
  atMs: number;
  txHash?: string;
  state: LinkState;
}

/** How long a payment the relayer did not confirm may still land. */
const SEND_WINDOW_MS = 10 * 60_000;

async function stateOf(wallet: PrivateWallet, s: StoredLink, now: number): Promise<LinkState> {
  if (s.ended) return s.ended;
  const link = linkFromStored(s);
  const note = linkNote(link);
  const tree = wallet.merkleTree;
  if (s.txHash === undefined && tree.indexOf(note.commitment) < 0) {
    return tree.size > 0 && now - s.atMs > SEND_WINDOW_MS ? "not sent" : "sending";
  }
  if (!(await poolView.isSpent(wallet.net, note.nullifier!))) return "waiting";
  // a take back may have written to the record while this read the pool
  const latest = () => wallet.links().find((x) => x.seed === s.seed) ?? s;
  const r = latest();
  if (r.ended) return r.ended;
  let ended: "claimed" | "taken back" = "claimed";
  if (r.takeBack) {
    // spent by this wallet's take back only if its first output is the note the take back made
    const spend = await poolView.spendOf(wallet.net, note.nullifier!);
    const back = makeNote(wallet.id.pk, link.token, link.amount, BigInt(r.takeBack));
    if (spend && BigInt(spend.outputs[0]) === back.commitment) ended = "taken back";
  }
  const last = latest();
  if (last.ended) return last.ended;
  await wallet.rememberLink({ ...last, ended });
  return ended;
}

/**
 * The links `wallet` paid, newest first, with where each stands, from the pool's nullifiers.
 * An ended link is kept as ended and not read again. Sync the wallet first for "not sent".
 */
export async function sentLinks(wallet: PrivateWallet, now = Date.now()): Promise<SentLink[]> {
  return Promise.all(
    wallet.links().map(async (s) => {
      const link = linkFromStored(s);
      return { link, code: encodeLink(link), atMs: s.atMs, ...(s.txHash ? { txHash: s.txHash } : {}), state: await stateOf(wallet, s, now) };
    }),
  );
}

/** Whether `wallet` paid this link: claiming it there is a take back. */
export function isOwnLink(wallet: PrivateWallet, link: Link): boolean {
  const seed = bytesToHex(link.seed);
  return wallet.links().some((x) => x.seed === seed);
}

/** Take back a link `wallet` paid that nobody has claimed: a claim to the wallet itself. */
export async function takeBackLink(wallet: PrivateWallet, link: Link, o: { artifacts: ArtifactSource; relayer: RelayerClient }): Promise<SendResult> {
  const seed = bytesToHex(link.seed);
  const s = wallet.links().find((x) => x.seed === seed);
  if (!s) throw new LinkError("This wallet did not pay that link.");
  const r = await claimLink(link, {
    to: wallet,
    ...o,
    memo: "Taken back from a link",
    beforeSend: (payment) => wallet.rememberLink({ ...s, takeBack: payment.blinding.toString() }),
  });
  await wallet.rememberLink({ ...s, takeBack: r.note.blinding.toString(), ended: "taken back" });
  return r;
}

/** Drop a link whose payment never reached the pool, after checking the pool afresh. */
export async function removeUnsentLink(wallet: PrivateWallet, link: Link): Promise<void> {
  const seed = bytesToHex(link.seed);
  const s = wallet.links().find((x) => x.seed === seed);
  if (!s) return;
  const tree = await loadTree(wallet.net);
  if (s.txHash || tree.indexOf(linkNote(link).commitment) >= 0) throw new LinkError("This link's payment is in the pool. Take it back instead.");
  await wallet.forgetLink(seed);
}
