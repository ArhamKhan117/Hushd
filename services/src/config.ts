/**
 * Service configuration from the environment. Every value has a public testnet default
 * except keys: with no keys a service runs read-only (the API) or refuses to start.
 */
import { MAINNET, TESTNET, withOverrides, type HushdNetwork } from "@hushd/sdk";

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v;
};

export function network(): HushdNetwork {
  const base = env("HUSHD_NETWORK", "testnet") === "mainnet" ? MAINNET : TESTNET;
  return withOverrides(base, {
    ...(env("NEAR_RPC_URL") ? { rpc: env("NEAR_RPC_URL")!.split(",") } : {}),
    ...(env("HUSHD_POOL") ? { pool: env("HUSHD_POOL")! } : {}),
    ...(env("HUSHD_DESK") ? { desk: env("HUSHD_DESK")! } : {}),
    ...(env("HUSHD_BOARD") ? { board: env("HUSHD_BOARD")! } : {}),
    ...(env("HUSHD_API_URL") ? { api: env("HUSHD_API_URL")! } : {}),
  });
}

export interface AccountConfig {
  accountId: string;
  privateKey: string;
  /** Optional gas key: parallel nonce lanes for throughput. */
  gasKey?: { privateKey: string; lanes: number };
}

/** `${PREFIX}_ACCOUNT`, `${PREFIX}_PRIVATE_KEY`, optional `${PREFIX}_GAS_KEY` and `${PREFIX}_LANES`. */
export function account(prefix: string): AccountConfig | null {
  const accountId = env(`${prefix}_ACCOUNT`);
  const privateKey = env(`${prefix}_PRIVATE_KEY`);
  if (!accountId || !privateKey) return null;
  const gas = env(`${prefix}_GAS_KEY`);
  return { accountId, privateKey, ...(gas ? { gasKey: { privateKey: gas, lanes: Number(env(`${prefix}_LANES`, "8")) } } : {}) };
}

export const settings = {
  port: (service: string, fallback: number) => Number(env(`${service.toUpperCase()}_PORT`, env("PORT", String(fallback)))),
  databaseUrl: () => env("DATABASE_URL", "postgres://localhost:5432/hushd")!,
  circuitsDir: () => env("HUSHD_CIRCUITS_DIR", new URL("../../app/public/circuits", import.meta.url).pathname)!,
  str: (k: string, d: string) => env(k, d)!,
  num: (k: string, d: number) => Number(env(k, String(d))),
};
