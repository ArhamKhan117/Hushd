/**
 * OTC packages: what a trader asks for, what a maker quotes, what both agree to,
 * and the bytes each side signs or hashes. The matcher enclave (Rust) encodes the
 * same bytes; `test/protocol.test.ts` pins them.
 *
 * Three templates:
 * - `spot`: sell one token for another, settled privately inside the pool (atomic).
 * - `spot_hedge`: the spot trade plus a Hyperliquid short of what was bought, so the
 *   trader keeps no price exposure; the maker bonds the hedge leg.
 * - `carry`: buy an asset with a stablecoin and short its perp of the same size
 *   (cash and carry, earning funding); also bonded.
 */
import { sha256 } from "@noble/hashes/sha2.js";

export type PackageKind = "spot" | "spot_hedge" | "carry";
export type SettlementClass = "atomic_pool" | "bonded_hedge" | "atomic_intents";
export type Outcome = "settled" | "recovered" | "failed" | "unresolved";

export interface Leg {
  /** NEP-141 token account id. */
  token: string;
  /** Exact amount in the token's smallest unit. */
  amount: bigint;
}

export interface HedgeLeg {
  venue: "hyperliquid";
  /** Hyperliquid coin, e.g. "BTC". */
  coin: string;
  /** Hyperliquid perp asset index on the chosen network. */
  asset: number;
  isBuy: boolean;
  /** Size and worst price in Hyperliquid's wire format. */
  size: string;
  limitPx: string;
  deadlineMs: number;
  testnet: boolean;
}

/** What the trader's agent sends, sealed to the enclave. */
export interface PackageRequest {
  v: 1;
  kind: PackageKind;
  sell: Leg;
  buy: { token: string; minAmount: bigint };
  /** For spot_hedge and carry: hedge the bought asset on Hyperliquid. */
  hedge?: { coin: string; testnet: boolean; maxSlippageBps: number };
  /** The quote must still hold this long. */
  expiresInMs: number;
  trader: {
    /** hushd1… receive address: the maker's note is made for it. */
    address: string;
    /** `inner` (0x hex) of a note a slashed bond pays into. */
    refundInner: string;
    /** ed25519:… per-deal key: only it can close the hedge. */
    ownerKey: string;
  };
  /** Words the trader typed, if any; never leaves the enclave. */
  text?: string;
  /**
   * 32 random bytes (0x hex), also sealed into the makers' ask: hashed into the terms, so the
   * public terms hash cannot be searched for the amounts. Without it the terms hash the plain way.
   */
  salt?: string;
}

/** A maker's firm answer, sealed to the enclave. */
export interface PackageQuote {
  v: 1;
  rfqId: number;
  maker: string;
  /** What the maker delivers (the trader's buy side). */
  give: Leg;
  /** What the maker takes (the trader's sell side). */
  take: Leg;
  hedge?: HedgeLeg;
  bond: bigint;
  expiresAtMs: number;
  /** hushd1… address the trader's note is made for. */
  makerAddress: string;
  /** The maker's quote key ("ed25519:<base58>"), as registered on the desk. */
  quoteKey: string;
  /** ed25519 signature (base64) by the quote key over `quoteConsent(desk, quote, kind)`. */
  signature: string;
}

/** The agreed deal, as both sides and the desk see it. */
export interface Terms {
  rfqId: number;
  maker: string;
  class: SettlementClass;
  traderGives: Leg;
  makerGives: Leg;
  hedge?: HedgeLeg;
  bond: bigint;
  expiresAtMs: number;
  /** The request's salt (0x hex, 32 bytes), when it carried one. */
  salt?: string;
}

export function classFor(kind: PackageKind): SettlementClass {
  return kind === "spot" ? "atomic_pool" : "bonded_hedge";
}

export function termsOf(q: PackageQuote, kind: PackageKind, salt?: string): Terms {
  return {
    rfqId: q.rfqId,
    maker: q.maker,
    class: classFor(kind),
    traderGives: q.take,
    makerGives: q.give,
    ...(q.hedge ? { hedge: q.hedge } : {}),
    bond: q.bond,
    expiresAtMs: q.expiresAtMs,
    ...(salt ? { salt } : {}),
  };
}

// ---------- canonical bytes ----------

const CLASS_TAG: Record<SettlementClass, number> = { atomic_pool: 0, bonded_hedge: 1, atomic_intents: 2 };
const enc = new TextEncoder();

export class Writer {
  private parts: number[] = [];
  bytes(b: Uint8Array): this {
    for (const x of b) this.parts.push(x);
    return this;
  }
  u8(v: number): this {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new RangeError("u8");
    this.parts.push(v);
    return this;
  }
  uint(v: bigint | number, bytes: number): this {
    let n = BigInt(v);
    if (n < 0n || n >= 1n << BigInt(bytes * 8)) throw new RangeError(`u${bytes * 8}`);
    for (let i = 0; i < bytes; i++) {
      this.parts.push(Number(n & 0xffn));
      n >>= 8n;
    }
    return this;
  }
  u32(v: number): this {
    return this.uint(v, 4);
  }
  u64(v: bigint | number): this {
    return this.uint(v, 8);
  }
  u128(v: bigint): this {
    return this.uint(v, 16);
  }
  str(s: string): this {
    const b = enc.encode(s);
    return this.u32(b.length).bytes(b);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** 32 bytes from 0x hex. */
function salt32(s: string): Uint8Array {
  const h = s.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new RangeError("salt is 32 bytes of 0x hex");
  return Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
}

/** The terms' canonical bytes: "hushd.terms.v1", or "hushd.terms.v2" ‖ salt (32) for a salted request, then the fields. */
export function termsBytes(t: Terms): Uint8Array {
  const head = t.salt ? new Writer().bytes(enc.encode("hushd.terms.v2")).bytes(salt32(t.salt)) : new Writer().bytes(enc.encode("hushd.terms.v1"));
  const w = head.u64(t.rfqId).str(t.maker).u8(CLASS_TAG[t.class]);
  w.str(t.traderGives.token).u128(t.traderGives.amount).str(t.makerGives.token).u128(t.makerGives.amount);
  if (t.hedge) {
    const h = t.hedge;
    w.u8(1).u32(h.asset).str(h.coin).u8(h.isBuy ? 1 : 0).str(h.size).str(h.limitPx).u64(h.deadlineMs).u8(h.testnet ? 1 : 0);
  } else {
    w.u8(0);
  }
  return w.u128(t.bond).u64(t.expiresAtMs).done();
}

export function termsHash(t: Terms): Uint8Array {
  return sha256(termsBytes(t));
}

/** The borsh bytes of the desk's `HedgeSpec`: asset u32, coin, is_buy, size, limit_px, deadline_ms u64, testnet. */
export function hedgeSpecBytes(h: HedgeLeg): Uint8Array {
  return new Writer().u32(h.asset).str(h.coin).u8(h.isBuy ? 1 : 0).str(h.size).str(h.limitPx).u64(h.deadlineMs).u8(h.testnet ? 1 : 0).done();
}

/** sha256 of the hedge spec's borsh bytes, or 32 zero bytes when there is no hedge. */
export function hedgeHash(h?: HedgeLeg): Uint8Array {
  return h ? sha256(hedgeSpecBytes(h)) : new Uint8Array(32);
}

/** Everything a maker's consent covers: the desk, the RFQ, the terms, the bond and its hedge leg. */
export interface Consent {
  /** The desk contract's account id: a consent for one desk is no good on another. */
  desk: string;
  rfqId: number;
  termsHash: Uint8Array;
  bond: bigint;
  expiresAtMs: number;
  class: SettlementClass;
  hedge?: HedgeLeg;
  maker: string;
}

/**
 * What the maker's quote key signs (consent v2): "hushd.quote.v2" ‖ desk ‖ rfq id (u64 LE) ‖
 * terms hash (32) ‖ bond (u128 LE) ‖ expiry (u64 LE) ‖ class (u8) ‖ hedge hash (32) ‖ maker,
 * account ids as u32 LE length ‖ utf8. The desk rebuilds these bytes from the match it gets,
 * so the matcher cannot attach a class, a hedge or a maker the maker did not sign.
 */
export function consentBytes(c: Consent): Uint8Array {
  if (c.termsHash.length !== 32) throw new RangeError("termsHash is 32 bytes");
  return new Writer()
    .bytes(enc.encode("hushd.quote.v2"))
    .str(c.desk)
    .u64(c.rfqId)
    .bytes(c.termsHash)
    .u128(c.bond)
    .u64(c.expiresAtMs)
    .u8(CLASS_TAG[c.class])
    .bytes(hedgeHash(c.hedge))
    .str(c.maker)
    .done();
}

/** The consent a maker signs for its quote on `desk`, for a request of this kind (and the request's salt, if it had one). */
export function quoteConsent(desk: string, q: PackageQuote, kind: PackageKind, salt?: string): Uint8Array {
  const t = termsOf(q, kind, salt);
  return consentBytes({ desk, rfqId: q.rfqId, termsHash: termsHash(t), bond: q.bond, expiresAtMs: q.expiresAtMs, class: t.class, hedge: q.hedge, maker: q.maker });
}

export function hex(b: Uint8Array): string {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** JSON with bigints as decimal strings (and back, for known bigint fields). */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

const BIGINT_KEYS = new Set(["amount", "minAmount", "bond"]);
export function fromJson<T>(s: string): T {
  return JSON.parse(s, (k, x) => (BIGINT_KEYS.has(k) && typeof x === "string" && /^\d+$/.test(x) ? BigInt(x) : x)) as T;
}

/** The best quote for a request: the most for the trader, inside the limit, still valid (a hedge must outlast the quote). */
export function bestQuote(req: PackageRequest, quotes: PackageQuote[], nowMs: number): PackageQuote | undefined {
  const ok = quotes.filter(
    (q) =>
      q.give.token === req.buy.token &&
      q.take.token === req.sell.token &&
      q.take.amount === req.sell.amount &&
      q.give.amount >= req.buy.minAmount &&
      q.expiresAtMs >= nowMs + Math.min(req.expiresInMs, 60_000) &&
      (req.kind === "spot") === (q.hedge === undefined) &&
      (q.hedge === undefined || q.hedge.deadlineMs > q.expiresAtMs),
  );
  ok.sort((a, b) => (a.give.amount === b.give.amount ? a.expiresAtMs - b.expiresAtMs : a.give.amount > b.give.amount ? -1 : 1));
  return ok[0];
}
