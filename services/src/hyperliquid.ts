/**
 * Hyperliquid for the hedge leg. Each deal's order is signed by NEAR Chain Signatures
 * from the desk's path `hushd/hedge/<deal id>`, so every deal trades from its own 20-byte
 * address. That address holds no margin: the maker's Hyperliquid account approves it as
 * an agent (`approveAgent`, signed with the maker's own key), so the MPC-signed order
 * trades on the maker's margin, and only for as long as the maker keeps it approved.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import { view, type HushdNetwork } from "@hushd/sdk";
import { settings } from "./config.js";

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const k = (b: Uint8Array) => keccak_256(b);
const word = (n: bigint) => unhex(n.toString(16).padStart(64, "0"));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** The 20-byte address Hyperliquid uses (keccak of the key) for an uncompressed secp256k1 public key (64 bytes x || y, or 65 with 0x04). */
export function evmAddress(publicKey: Uint8Array): string {
  const xy = publicKey.length === 65 ? publicKey.slice(1) : publicKey;
  if (xy.length !== 64) throw new Error("expected an uncompressed secp256k1 public key");
  return `0x${hex(k(xy).slice(12))}`;
}

/** The Hyperliquid address of a private key (0x hex). */
export function addressOfKey(privateKeyHex: string): string {
  return evmAddress(secp256k1.getPublicKey(unhex(privateKeyHex), false));
}

/** A deal's Hyperliquid address: the MPC key derived for the desk at `hushd/hedge/<deal id>`. */
export async function dealAddress(net: HushdNetwork, dealId: number | string): Promise<string> {
  const key = await view<string>(net, net.mpc, "derived_public_key", { path: `hushd/hedge/${dealId}`, predecessor: net.desk, domain_id: 0 });
  const raw = base58.decode(key.replace(/^secp256k1:/, ""));
  return evmAddress(raw);
}

type Field = ["string", string, string] | ["address", string, string] | ["uint64", string, number | bigint] | ["bool", string, boolean];

/** EIP-712 digest of a user-signed Hyperliquid action ("HyperliquidSignTransaction" domain, chain 0x66eee). */
function userActionDigest(primaryType: string, fields: Field[]): Uint8Array {
  const domainType = k(enc.encode("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const domain = k(concat(domainType, k(enc.encode("HyperliquidSignTransaction")), k(enc.encode("1")), word(0x66eeen), word(0n)));
  const type = k(enc.encode(`HyperliquidTransaction:${primaryType}(${fields.map(([t, n]) => `${t} ${n}`).join(",")})`));
  const values = fields.map(([t, , v]) => (t === "string" ? k(enc.encode(v as string)) : t === "bool" ? word(v ? 1n : 0n) : word(BigInt(v as string | number | bigint))));
  return k(concat(Uint8Array.of(0x19, 0x01), domain, k(concat(type, ...values))));
}

/** EIP-712 digest of a user-signed `approveAgent`. */
export function approveAgentDigest(a: { agentAddress: string; agentName: string; nonce: number; testnet: boolean }): Uint8Array {
  return userActionDigest("ApproveAgent", [
    ["string", "hyperliquidChain", a.testnet ? "Testnet" : "Mainnet"],
    ["address", "agentAddress", a.agentAddress],
    ["string", "agentName", a.agentName],
    ["uint64", "nonce", a.nonce],
  ]);
}

/** EIP-712 digest of a user-signed `usdSend` (USDC from one Hyperliquid account to another). */
export function usdSendDigest(a: { destination: string; amount: string; time: number; testnet: boolean }): Uint8Array {
  return userActionDigest("UsdSend", [
    ["string", "hyperliquidChain", a.testnet ? "Testnet" : "Mainnet"],
    ["string", "destination", a.destination],
    ["string", "amount", a.amount],
    ["uint64", "time", a.time],
  ]);
}

/** EIP-712 digest of a user-signed `usdClassTransfer` (USDC between the account's spot and perps balances). */
export function usdClassTransferDigest(a: { amount: string; toPerp: boolean; nonce: number; testnet: boolean }): Uint8Array {
  return userActionDigest("UsdClassTransfer", [
    ["string", "hyperliquidChain", a.testnet ? "Testnet" : "Mainnet"],
    ["string", "amount", a.amount],
    ["bool", "toPerp", a.toPerp],
    ["uint64", "nonce", a.nonce],
  ]);
}

/** Sign a digest with a secp256k1 key the way Hyperliquid expects ({ r, s, v } with v = 27 or 28). */
export function signDigest(privateKeyHex: string, digest: Uint8Array) {
  const sig = secp256k1.sign(digest, unhex(privateKeyHex), { prehash: false, format: "recovered" });
  return { r: `0x${hex(sig.slice(1, 33))}`, s: `0x${hex(sig.slice(33, 65))}`, v: 27 + sig[0]! };
}

/** The maker approves a deal's MPC address as its (unnamed) agent on Hyperliquid. */
export async function approveDealAgent(makerKeyHex: string, agentAddress: string, testnet: boolean, now = Date.now()) {
  const nonce = now;
  const signature = signDigest(makerKeyHex, approveAgentDigest({ agentAddress, agentName: "", nonce, testnet }));
  // signed with an empty name; an unnamed agent is sent without the field
  const action = { type: "approveAgent", signatureChainId: "0x66eee", hyperliquidChain: testnet ? "Testnet" : "Mainnet", agentAddress, nonce };
  const url = settings.str(testnet ? "HYPERLIQUID_TESTNET_EXCHANGE_URL" : "HYPERLIQUID_EXCHANGE_URL", testnet ? "https://api.hyperliquid-testnet.xyz/exchange" : "https://api.hyperliquid.xyz/exchange");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce, signature }), signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({ status: "err", response: `HTTP ${res.status}` }))) as { status: string; response?: unknown };
  if (body.status !== "ok") throw new Error(`Hyperliquid refused approveAgent: ${JSON.stringify(body.response)}`);
  return { agentAddress, nonce };
}

/** Send USDC (whole units as a decimal string) from the account of `keyHex` to `destination` on Hyperliquid. */
export async function usdSend(keyHex: string, destination: string, amount: string, testnet: boolean, now = Date.now()) {
  const signature = signDigest(keyHex, usdSendDigest({ destination, amount, time: now, testnet }));
  const action = { type: "usdSend", signatureChainId: "0x66eee", hyperliquidChain: testnet ? "Testnet" : "Mainnet", destination, amount, time: now };
  const url = settings.str(testnet ? "HYPERLIQUID_TESTNET_EXCHANGE_URL" : "HYPERLIQUID_EXCHANGE_URL", testnet ? "https://api.hyperliquid-testnet.xyz/exchange" : "https://api.hyperliquid.xyz/exchange");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce: now, signature }), signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({ status: "err", response: `HTTP ${res.status}` }))) as { status: string; response?: unknown };
  if (body.status !== "ok") throw new Error(`Hyperliquid refused usdSend: ${JSON.stringify(body.response)}`);
}

/** Move USDC (whole units as a decimal string) between the spot and perps balances of the account of `keyHex`: hedges use perps margin, and a transfer into an account lands in spot. */
export async function usdClassTransfer(keyHex: string, amount: string, toPerp: boolean, testnet: boolean, now = Date.now()) {
  const signature = signDigest(keyHex, usdClassTransferDigest({ amount, toPerp, nonce: now, testnet }));
  const action = { type: "usdClassTransfer", signatureChainId: "0x66eee", hyperliquidChain: testnet ? "Testnet" : "Mainnet", amount, toPerp, nonce: now };
  const url = settings.str(testnet ? "HYPERLIQUID_TESTNET_EXCHANGE_URL" : "HYPERLIQUID_EXCHANGE_URL", testnet ? "https://api.hyperliquid-testnet.xyz/exchange" : "https://api.hyperliquid.xyz/exchange");
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, nonce: now, signature }), signal: AbortSignal.timeout(15_000) });
  const body = (await res.json().catch(() => ({ status: "err", response: `HTTP ${res.status}` }))) as { status: string; response?: unknown };
  if (body.status !== "ok") throw new Error(`Hyperliquid refused usdClassTransfer: ${JSON.stringify(body.response)}`);
}
