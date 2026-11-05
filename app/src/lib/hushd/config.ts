/** The network the app runs on and where its services are, from public env with testnet defaults. */
import { TESTNET, withOverrides, type HushdNetwork } from "@hushd/sdk";

export const API_URL = process.env.NEXT_PUBLIC_HUSHD_API_URL || "https://api.hushd.net";

export const NETWORK: HushdNetwork = withOverrides(TESTNET, {
  api: API_URL,
  ...(process.env.NEXT_PUBLIC_NEAR_RPC_URL ? { rpc: process.env.NEXT_PUBLIC_NEAR_RPC_URL.split(",") } : {}),
  ...(process.env.NEXT_PUBLIC_HUSHD_POOL ? { pool: process.env.NEXT_PUBLIC_HUSHD_POOL } : {}),
  ...(process.env.NEXT_PUBLIC_HUSHD_DESK ? { desk: process.env.NEXT_PUBLIC_HUSHD_DESK } : {}),
  ...(process.env.NEXT_PUBLIC_HUSHD_BOARD ? { board: process.env.NEXT_PUBLIC_HUSHD_BOARD } : {}),
});

/** Proving artifacts, published by `pnpm --filter @hushd/circuits publish-artifacts`. */
export const CIRCUITS_BASE = "/circuits";
