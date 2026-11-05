/**
 * Where Hushd lives on each network. Testnet holds every contract; mainnet is used
 * only for NEAR Intents (no Hushd contract is deployed there).
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
  /** RPC endpoints, tried in order. */
  rpc: string[];
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
  rpc: ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"],
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

export const MAINNET: HushdNetwork = {
  id: "mainnet",
  rpc: ["https://free.rpc.fastnear.com"],
  pool: null,
  desk: null,
  board: null,
  tokens: [],
  bondToken: null,
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

export function tokenInfo(net: HushdNetwork, id: string): TokenInfo {
  const t = net.tokens.find((x) => x.id === id || x.symbol.toLowerCase() === id.toLowerCase());
  if (!t) throw new Error(`unknown token ${id} on ${net.id}`);
  return t;
}

export const txUrl = (net: HushdNetwork, hash: string) => `${net.explorer}/txns/${hash}`;
export const accountUrl = (net: HushdNetwork, account: string) => `${net.explorer}/address/${account}`;
