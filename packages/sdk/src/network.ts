/**
 * Where Hushd lives on each network. Testnet runs every contract today. MAINNET names
 * where they go (`*.hushd.near`) and the real tokens they take; until they are deployed
 * there, mainnet is used only for NEAR Intents (`deployed: false`).
 */

export interface TokenInfo {
  id: string;
  symbol: string;
  decimals: number;
  /** Hyperliquid coin that hedges this token, if any. */
  hedgeCoin?: string;
}

export interface HushdNetwork {
  id: "testnet" | "mainnet";
  /** Whether the Hushd contracts below exist on this network yet. */
  deployed: boolean;
  /** Free RPC endpoints a server reads from; calls rotate across them and fail over (`rpcOrder`). */
  rpc: string[];
  /**
   * The ones among `rpc` that take transactions (`sendEndpoints`). Free dRPC refuses a
   * transaction with more than about 2 KB of arguments, which every pool `transact` has.
   */
  rpcSend?: string[];
  /**
   * The endpoints a browser reads from first: providers whose every answer, a rate-limited one
   * included, carries CORS headers. FastNEAR answers a rate-limited call without them, which a
   * browser logs as a CORS error, so in a browser it is only a fallback (`forBrowser`).
   */
  browserRpc?: string[];
  /**
   * Ask a rate-limited endpoint of `rpc` once more, after a pause, before turning to
   * `rpcFallback`. `forBrowser` sets it: there the fallback is FastNEAR, whose 429s a browser
   * can only read as CORS errors. A server goes straight to its fallback.
   */
  retryRateLimited?: boolean;
  /**
   * Requests carry a salt the terms are hashed with (protocol `termsBytes`), so a deal's public
   * terms hash cannot be searched for its amounts. On once the desk pins an enclave build that
   * hashes salted terms.
   */
  termsSalt?: boolean;
  /**
   * Tried, in order, only after every endpoint in `rpc` has failed. A server keeps dRPC here, so
   * a browser on the same address (a local run) keeps dRPC's quota for itself.
   */
  rpcFallback?: string[];
  pool: string | null;
  desk: string | null;
  board: string | null;
  tokens: TokenInfo[];
  /** The token makers bond (and a slashed bond pays in). */
  bondToken: string | null;
  /** Hushd API (relayer, indexer reads): `${api}/v1/...`. */
  api: string;
  explorer: string;
  intentsExplorer: string;
  mpc: string;
  outlayer: string;
}

export const TESTNET: HushdNetwork = {
  id: "testnet",
  deployed: true,
  rpc: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"],
  rpcSend: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"],
  rpcFallback: ["https://near-testnet.drpc.org"],
  browserRpc: ["https://near-testnet.drpc.org"],
  // on once the desk's pin to the enclave build 95cba282... applies (after 2026-11-11 00:35 UTC)
  termsSalt: false,
  pool: "pool.hushd.testnet",
  desk: "desk.hushd.testnet",
  board: "board.hushd.testnet",
  tokens: [
    { id: "usdc.hushd.testnet", symbol: "USDC", decimals: 6 },
    { id: "wnear.hushd.testnet", symbol: "wNEAR", decimals: 24, hedgeCoin: "NEAR" },
    { id: "btc.hushd.testnet", symbol: "BTC", decimals: 8, hedgeCoin: "BTC" },
  ],
  bondToken: "usdc.hushd.testnet",
  api: "https://api.hushd.net",
  explorer: "https://testnet.nearblocks.io",
  intentsExplorer: "https://explorer.near-intents.org",
  mpc: "v1.signer-prod.testnet",
  outlayer: "outlayer.testnet",
};

/** Native USDC on NEAR (Circle). */
export const MAINNET_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export const MAINNET: HushdNetwork = {
  id: "mainnet",
  deployed: false,
  rpc: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com"],
  rpcSend: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com"],
  rpcFallback: ["https://near.drpc.org"],
  browserRpc: ["https://near.drpc.org", "https://near.api.pocket.network"],
  termsSalt: true,
  pool: "pool.hushd.near",
  desk: "desk.hushd.near",
  board: "board.hushd.near",
  tokens: [
    { id: MAINNET_USDC, symbol: "USDC", decimals: 6 },
    { id: "wrap.near", symbol: "wNEAR", decimals: 24, hedgeCoin: "NEAR" },
    { id: "nbtc.bridge.near", symbol: "BTC", decimals: 8, hedgeCoin: "BTC" },
  ],
  bondToken: MAINNET_USDC,
  api: "https://api.hushd.net",
  explorer: "https://nearblocks.io",
  intentsExplorer: "https://explorer.near-intents.org",
  mpc: "v1.signer",
  outlayer: "outlayer.near",
};

/** Override any field (a local sandbox, a self-hosted API). */
export function withOverrides(base: HushdNetwork, o: Partial<HushdNetwork>): HushdNetwork {
  // an override of `rpc` names the endpoints to use (a local node): the base's fallbacks are another network's
  return { ...base, ...(o.rpc && !o.rpcFallback ? { rpcFallback: [] } : {}), ...o };
}

/** The endpoints to send transactions through: `rpcSend` where it overlaps `rpc` or `rpcFallback` (an override of `rpc` alone, like a sandbox, sends there). */
export function sendEndpoints(net: HushdNetwork): string[] {
  const known = [...net.rpc, ...(net.rpcFallback ?? [])];
  const send = (net.rpcSend ?? []).filter((u) => known.includes(u));
  return send.length ? send : net.rpc;
}

/** The network as a browser should read it: `browserRpc` first, the other endpoints only as a fallback. Sends still use `rpcSend`. */
export function forBrowser(net: HushdNetwork): HushdNetwork {
  const first = net.browserRpc ?? [];
  if (!first.length) return net;
  return { ...net, rpc: first, rpcFallback: [...net.rpc, ...(net.rpcFallback ?? [])].filter((u) => !first.includes(u)), retryRateLimited: true };
}

/** Every endpoint a network may call: reads, fallbacks and sends. */
export function allEndpoints(net: HushdNetwork): string[] {
  return [...new Set([...net.rpc, ...(net.rpcFallback ?? []), ...(net.rpcSend ?? [])])];
}

export function tokenInfo(net: HushdNetwork, id: string): TokenInfo {
  const t = net.tokens.find((x) => x.id === id || x.symbol.toLowerCase() === id.toLowerCase());
  if (!t) throw new Error(`unknown token ${id} on ${net.id}`);
  return t;
}

export const txUrl = (net: HushdNetwork, hash: string) => `${net.explorer}/txns/${hash}`;
export const accountUrl = (net: HushdNetwork, account: string) => `${net.explorer}/address/${account}`;
