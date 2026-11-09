/**
 * The Content-Security-Policy Hushd is moving towards. It is sent as
 * Content-Security-Policy-Report-Only (next.config.ts): browsers report what it would
 * block in the console but block nothing, so the list is checked against real use
 * before it is enforced.
 */

const origin = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};

/**
 * Per network: the free RPC endpoints (the same lists as `rpc` and `browserRpc` of `TESTNET` and
 * `MAINNET` in packages/sdk/src/network.ts; change them together) and OutLayer's custody API
 * (`CUSTODY` in packages/sdk/src/custody.ts).
 */
const NETWORKS = {
  testnet: {
    rpc: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"],
    outlayer: "https://testnet-api.outlayer.ai",
  },
  mainnet: {
    rpc: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com", "https://near.drpc.org", "https://near.api.pocket.network"],
    outlayer: "https://api.outlayer.ai",
  },
};
const NET = NETWORKS[process.env.NEXT_PUBLIC_HUSHD_NETWORK === "mainnet" ? "mainnet" : "testnet"];
const RPC_OVERRIDE = (process.env.NEXT_PUBLIC_NEAR_RPC_URL || "").split(",").map((u) => u.trim()).filter(Boolean);

/** Hosts the app reads from the browser: analytics, the Hushd API, NEAR RPC, the NEAR Connect wallet list, OutLayer custody. */
const SERVICES = [
  "https://va.vercel-scripts.com",
  origin(process.env.NEXT_PUBLIC_HUSHD_API_URL || "https://api.hushd.net"),
  ...(RPC_OVERRIDE.length ? RPC_OVERRIDE : NET.rpc).map(origin),
  "https://raw.githubusercontent.com",
  // OutLayer custody: an owner's browser registers an agent's policy wallet and sets its policy
  NET.outlayer,
].filter((x, i, all) => x && all.indexOf(x) === i);

export const CSP_CONNECT_SOURCES = ["'self'", ...SERVICES];

export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  // Next's inline bootstrap scripts need 'unsafe-inline' until nonces are wired; the prover needs WebAssembly
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://va.vercel-scripts.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src ${CSP_CONNECT_SOURCES.join(" ")}`,
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
