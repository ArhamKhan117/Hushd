/**
 * The network the app runs on and where its services are, from public env.
 * `NEXT_PUBLIC_HUSHD_NETWORK` picks testnet (the default) or mainnet; the other
 * variables override single fields, for a local sandbox node or a self-hosted API.
 */
import { MAINNET, TESTNET, withOverrides, type HushdNetwork } from "@hushd/sdk";

const BASE: HushdNetwork = process.env.NEXT_PUBLIC_HUSHD_NETWORK === "mainnet" ? MAINNET : TESTNET;

export const API_URL = process.env.NEXT_PUBLIC_HUSHD_API_URL || BASE.api;

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const rpc = list(process.env.NEXT_PUBLIC_NEAR_RPC_URL);

export const NETWORK: HushdNetwork = withOverrides(BASE, {
  api: API_URL,
  ...(rpc.length ? { rpc } : {}),
  ...(process.env.NEXT_PUBLIC_HUSHD_POOL ? { pool: process.env.NEXT_PUBLIC_HUSHD_POOL } : {}),
  ...(process.env.NEXT_PUBLIC_HUSHD_DESK ? { desk: process.env.NEXT_PUBLIC_HUSHD_DESK } : {}),
  ...(process.env.NEXT_PUBLIC_HUSHD_BOARD ? { board: process.env.NEXT_PUBLIC_HUSHD_BOARD } : {}),
});

/** Testnet has a faucet and a relayer that opens passkey accounts; mainnet has neither. */
export const IS_TESTNET = NETWORK.id === "testnet";

/** A NEAR account to show as an example reader of a proof. */
export const EXAMPLE_READER = IS_TESTNET ? "auditor.testnet" : "auditor.near";

/** Proving artifacts, published by `pnpm --filter @hushd/circuits publish-artifacts`. */
export const CIRCUITS_BASE = "/circuits";
