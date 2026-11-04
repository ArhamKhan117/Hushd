/**
 * OTC packages: what a trader asks for, what a maker quotes, what both agree to,
 * and the bytes each side signs or hashes. The matcher enclave (Rust) encodes the
 * same bytes; `test/vectors.json` pins them.
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
  /** ed25519 signature (base64) over consentBytes(rfqId, termsHash(terms), bond, expiresAtMs). */
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
}

export function classFor(kind: PackageKind): SettlementClass {
  return kind === "spot" ? "atomic_pool" : "bonded_hedge";
}

export function termsOf(q: PackageQuote, kind: PackageKind): Terms {
  return {
    rfqId: q.rfqId,
    maker: q.maker,
    class: classFor(kind),
    traderGives: q.take,
    makerGives: q.give,
    ...(q.hedge ? { hedge: q.hedge } : {}),
    bond: q.bond,
    expiresAtMs: q.expiresAtMs,
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

export function termsBytes(t: Terms): Uint8Array {
  const w = new Writer().bytes(enc.encode("hushd.terms.v1")).u64(t.rfqId).str(t.maker).u8(CLASS_TAG[t.class]);
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

/** What the maker's quote key signs: its consent to exactly these terms for this RFQ. */
export function consentBytes(rfqId: number, termsHash: Uint8Array, bond: bigint, expiresAtMs: number): Uint8Array {
  if (termsHash.length !== 32) throw new RangeError("termsHash is 32 bytes");
  return new Writer().bytes(enc.encode("hushd.quote.v1")).u64(rfqId).bytes(termsHash).u128(bond).u64(expiresAtMs).done();
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

/** The best quote for a request: the most for the trader, inside the limit, still valid. */
export function bestQuote(req: PackageRequest, quotes: PackageQuote[], nowMs: number): PackageQuote | undefined {
  const ok = quotes.filter(
    (q) =>
      q.give.token === req.buy.token &&
      q.take.token === req.sell.token &&
      q.take.amount === req.sell.amount &&
      q.give.amount >= req.buy.minAmount &&
      q.expiresAtMs >= nowMs + Math.min(req.expiresInMs, 60_000) &&
      (req.kind === "spot") === (q.hedge === undefined),
  );
  ok.sort((a, b) => (a.give.amount === b.give.amount ? a.expiresAtMs - b.expiresAtMs : a.give.amount > b.give.amount ? -1 : 1));
  return ok[0];
}
