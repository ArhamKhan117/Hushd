/**
 * An agent's Hushd context: its identity (from a 32-byte seed it alone holds), its
 * private wallet (notes in an encrypted file), the relayer, the desk API, spending
 * limits and, optionally, a NEAR account for moving tokens into the pool.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeskApi, identityFromSeed, loadPoseidon, PrivateWallet, RelayerClient, TESTNET, withOverrides, type ArtifactSource, type HushdNetwork, type Identity } from "@hushd/sdk";
import { cachedArtifacts, EncryptedFileStore } from "@hushd/sdk/node";
import { Near } from "near-kit";
import { DEFAULT_PER_DAY, DEFAULT_PER_PAYMENT, Limits, parseCaps } from "./limits.js";

export interface Env {
  [k: string]: string | undefined;
}

export function networkFrom(env: Env): HushdNetwork {
  if ((env.HUSHD_NETWORK ?? "testnet") !== "testnet") throw new Error("Hushd's contracts run on NEAR testnet; set HUSHD_NETWORK=testnet");
  return withOverrides(TESTNET, {
    ...(env.HUSHD_API_URL ? { api: env.HUSHD_API_URL } : {}),
    ...(env.HUSHD_RPC_URL ? { rpc: env.HUSHD_RPC_URL.split(",") } : {}),
  });
}

export const homeDir = (env: Env) => env.HUSHD_HOME ?? join(homedir(), ".hushd");

/** The seed: HUSHD_SEED (64 hex), else the file `hushd-mcp init` wrote. */
export function loadSeed(env: Env): Uint8Array | null {
  const hex = env.HUSHD_SEED ?? (existsSync(join(homeDir(env), "seed")) ? readFileSync(join(homeDir(env), "seed"), "utf8").trim() : "");
  if (!hex) return null;
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("HUSHD_SEED must be 32 bytes of hex");
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/** Write a fresh seed to ~/.hushd/seed (mode 600) unless one exists. */
export function initSeed(env: Env): { path: string; created: boolean } {
  const dir = homeDir(env);
  const path = join(dir, "seed");
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
  return { path, created: true };
}

export interface Agent {
  net: HushdNetwork;
  id: Identity;
  wallet: PrivateWallet;
  relayer: RelayerClient;
  api: DeskApi;
  limits: Limits;
  artifacts: ArtifactSource;
  /** Present when HUSHD_NEAR_ACCOUNT and HUSHD_NEAR_PRIVATE_KEY are set. */
  near: { accountId: string; client: Near } | null;
}

export async function artifactsFor(env: Env): Promise<ArtifactSource> {
  return cachedArtifacts({ ...(env.HUSHD_CIRCUITS_DIR ? { dir: env.HUSHD_CIRCUITS_DIR } : {}), ...(env.HUSHD_CIRCUITS_URL ? { baseUrl: env.HUSHD_CIRCUITS_URL } : {}), cacheDir: join(homeDir(env), "circuits") });
}

export async function createAgent(env: Env, seed: Uint8Array): Promise<Agent> {
  await loadPoseidon();
  const net = networkFrom(env);
  const id = identityFromSeed(seed);
  const relayer = new RelayerClient(net.api);
  const artifacts = await artifactsFor(env);
  const tag = id.address.slice(-12);
  const wallet = new PrivateWallet(net, id, { artifacts, relayer, store: new EncryptedFileStore(join(homeDir(env), `${net.id}-${tag}.notes`), seed) });
  await wallet.restore();
  const limits = new Limits(net, parseCaps(net, env.HUSHD_LIMIT_PER_PAYMENT ?? DEFAULT_PER_PAYMENT), parseCaps(net, env.HUSHD_LIMIT_PER_DAY ?? DEFAULT_PER_DAY), join(homeDir(env), `${net.id}-${tag}.spent.json`));
  const near =
    env.HUSHD_NEAR_ACCOUNT && env.HUSHD_NEAR_PRIVATE_KEY
      ? {
          accountId: env.HUSHD_NEAR_ACCOUNT,
          client: new Near({ network: { networkId: net.id, rpcUrl: net.rpc[0]! }, privateKey: env.HUSHD_NEAR_PRIVATE_KEY as `ed25519:${string}`, defaultSignerId: env.HUSHD_NEAR_ACCOUNT }),
        }
      : null;
  return { net, id, wallet, relayer, api: new DeskApi(net.api), limits, artifacts, near };
}
