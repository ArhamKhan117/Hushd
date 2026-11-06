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
  /** Free RPC endpoints; calls rotate across them and fail over (`rpcOrder`). */
  rpc: string[];
  /**
   * The ones among `rpc` that take transactions (`sendEndpoints`). Free dRPC refuses a
   * transaction with more than about 2 KB of arguments, which every pool `transact` has.
   */
  rpcSend?: string[];
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
  rpc: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org"],
  rpcSend: ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"],
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
  rpc: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com", "https://near.drpc.org"],
  rpcSend: ["https://free.rpc.fastnear.com", "https://rpc.mainnet.fastnear.com"],
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
  return { ...base, ...o };
}

/** The endpoints to send transactions through: `rpcSend` where it overlaps `rpc` (an override of `rpc` alone, like a sandbox, sends there). */
export function sendEndpoints(net: HushdNetwork): string[] {
  const send = (net.rpcSend ?? []).filter((u) => net.rpc.includes(u));
  return send.length ? send : net.rpc;
}

export function tokenInfo(net: HushdNetwork, id: string): TokenInfo {
  const t = net.tokens.find((x) => x.id === id || x.symbol.toLowerCase() === id.toLowerCase());
  if (!t) throw new Error(`unknown token ${id} on ${net.id}`);
  return t;
}

export const txUrl = (net: HushdNetwork, hash: string) => `${net.explorer}/txns/${hash}`;
export const accountUrl = (net: HushdNetwork, account: string) => `${net.explorer}/address/${account}`;
