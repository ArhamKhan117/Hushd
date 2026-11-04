/**
 * The encrypted heads-up board: how a recipient learns about a note made for them.
 * Each post is a sealed box (box.ts) of a NoteMessage, encrypted to the recipient's
 * X25519 key; recipients page through every post and keep what opens.
 * Change and refund notes are posted to yourself, so a seed alone recovers a wallet.
 */
import { openJson, sealJson } from "./box.js";
import type { Identity, ReceiveAddress } from "./keys.js";
import type { HushdNetwork } from "./network.js";
import { makeNote, own, type Note } from "./note.js";
import { view } from "./rpc.js";

export interface NoteMessage {
  v: 1;
  token: string;
  amount: string;
  blinding: string;
  memo?: string;
  /** A deal this note settles, if any. */
  dealId?: string;
}

export interface PostView {
  index: string;
  data: string;
  tag: string | null;
  block_height: string;
  timestamp_ns: string;
}

const fromB64 = (s: string) => (typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
export const toB64 = (b: Uint8Array) => (typeof Buffer !== "undefined" ? Buffer.from(b).toString("base64") : btoa(String.fromCharCode(...b)));

export function noteMessage(note: Note, extra: { memo?: string; dealId?: bigint } = {}): NoteMessage {
  return {
    v: 1,
    token: note.token,
    amount: note.amount.toString(),
    blinding: note.blinding.toString(),
    ...(extra.memo ? { memo: extra.memo } : {}),
    ...(extra.dealId !== undefined ? { dealId: extra.dealId.toString() } : {}),
  };
}

/** The ciphertext to post for `to` (base64). */
export function sealNote(to: ReceiveAddress, note: Note, extra: { memo?: string; dealId?: bigint } = {}): string {
  return toB64(sealJson(to.encPublic, noteMessage(note, extra)));
}

/** Try to open a post as a note for `id`. */
export function openNote(id: Identity, data: string): (Note & { memo?: string; dealId?: string }) | null {
  const m = openJson<NoteMessage>(id.encSecret, fromB64(data));
  if (!m || m.v !== 1) return null;
  try {
    const note = own(makeNote(id.pk, m.token, BigInt(m.amount), BigInt(m.blinding)), id);
    return { ...note, ...(m.memo ? { memo: m.memo } : {}), ...(m.dealId ? { dealId: m.dealId } : {}) };
  } catch {
    return null;
  }
}

export const boardView = {
  count: async (net: HushdNetwork) => Number(await view<string>(net, board(net), "count")),
  posts: (net: HushdNetwork, from: number, limit = 100) => view<PostView[]>(net, board(net), "posts", { from_index: String(from), limit }),
};

function board(net: HushdNetwork): string {
  if (!net.board) throw new Error(`no Hushd board on ${net.id}`);
  return net.board;
}

/** Every post from `from` on that opens for `id`. */
export async function scanBoard(net: HushdNetwork, id: Identity, from = 0): Promise<{ notes: ReturnType<typeof openNote>[]; next: number }> {
  const total = await boardView.count(net);
  const notes: NonNullable<ReturnType<typeof openNote>>[] = [];
  let i = from;
  while (i < total) {
    const page = await boardView.posts(net, i, 100);
    if (page.length === 0) break;
    for (const p of page) {
      const n = openNote(id, p.data);
      if (n) notes.push(n);
    }
    i += page.length;
  }
  return { notes, next: i };
}
