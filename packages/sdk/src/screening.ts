/**
 * Sanctions screening of public addresses only: the NEAR account a deposit comes from, the
 * NEAR account a cash out pays, and the address on another chain that a deposit or a cash
 * out through NEAR Intents uses. Never a note, a hushd1… address, an amount or anything else
 * private.
 *
 * The list is a dated snapshot of the digital currency addresses on OFAC's SDN list, kept in
 * sanctions-list.ts as the first 8 bytes of SHA-256 of each address in normal form.
 * `pnpm --filter @hushd/sdk refresh-sanctions` rebuilds it from OFAC's own file.
 *
 * The app checks before you sign, the API answers `POST /v1/screen`, and the relayer checks
 * a cash out's recipient again before it sends it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { hex as hexCodec } from "@scure/base";
import { SANCTIONS } from "./sanctions-list.js";

/** All a blocked address is ever told: no reason, no list, no echo of the address. */
export const SCREENED_MESSAGE = "This address can't be used with Hushd.";

export type ScreenResult = { allowed: true } | { allowed: false; message: string };

/** Where the vendored list comes from and how big it is. */
export const sanctionsSnapshot = {
  source: SANCTIONS.source,
  published: SANCTIONS.published,
  sourceSha256: SANCTIONS.sourceSha256,
  addresses: SANCTIONS.count,
};

/**
 * An address in normal form: trimmed; 0x hex and any address written in one case
 * (bech32, NEAR accounts) in lowercase; a mixed-case address (base58) exactly as written.
 */
export function normalizeAddress(address: string): string {
  const a = address.trim();
  if (/^0x[0-9a-fA-F]+$/.test(a)) return a.toLowerCase();
  return a === a.toLowerCase() || a === a.toUpperCase() ? a.toLowerCase() : a;
}

/** The list's key for an address: the first 8 bytes of SHA-256 of its normal form, in hex. */
export function addressKey(address: string): string {
  return hexCodec.encode(sha256(new TextEncoder().encode(normalizeAddress(address))).slice(0, 8));
}

let listed: Set<string> | null = null;

/** Whether an address is on the vendored sanctions list. */
export function isSanctioned(address: string): boolean {
  listed ??= new Set(SANCTIONS.keys.match(/.{16}/g) ?? []);
  return address.trim() !== "" && listed.has(addressKey(address));
}

/** Screen the public addresses of one action: blocked if any is listed. Empty values are skipped. */
export function screenAddresses(addresses: readonly (string | null | undefined)[]): ScreenResult {
  return addresses.some((a) => typeof a === "string" && isSanctioned(a)) ? { allowed: false, message: SCREENED_MESSAGE } : { allowed: true };
}
