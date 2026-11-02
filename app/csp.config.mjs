/**
 * The Content-Security-Policy Hushd is moving towards. It is sent as
 * Content-Security-Policy-Report-Only (next.config.ts): browsers report what it would
 * block in the console but block nothing, so the list is checked against real use
 * before it is enforced.
 */

/** Hosts the app reads from the browser. */
const SERVICES = ["https://va.vercel-scripts.com"];

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
