/**
 * An agent's Hushd context: its identity (from a 32-byte seed it alone holds), its
 * private wallet (notes in an encrypted file), the relayer, the desk API, spending
 * limits and, optionally, a NEAR account for moving tokens into the pool: its own key,
 * or an OutLayer policy wallet whose owner's rules are checked in a TEE before it signs.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CUSTODY, CustodyWallet, custodyView, DeskApi, identityFromSeed, keepRpcErrorBodies, loadPoseidon, PrivateWallet, RelayerClient, sendEndpoints, TESTNET, withOverrides, type ArtifactSource, type CallSpec, type HushdNetwork, type Identity } from "@hushd/sdk";
import { cachedArtifacts, EncryptedFileStore } from "@hushd/sdk/node";
import { Near } from "near-kit";
import { DEFAULT_PER_DAY, DEFAULT_PER_PAYMENT, Limits, parseCaps, parseRules } from "./limits.js";

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

/** The agent's NEAR account: one call at a time, signed by its own key or by its policy wallet. */
export interface NearAccount {
  accountId: string;
  kind: "key" | "policy-wallet";
  call(c: CallSpec): Promise<string>;
  /** Set for a policy wallet: the wallet and its key in OutLayer's spelling. */
  wallet?: { client: CustodyWallet; pubkey: string };
}

export interface Agent {
  net: HushdNetwork;
  id: Identity;
  wallet: PrivateWallet;
  relayer: RelayerClient;
  api: DeskApi;
  limits: Limits;
  artifacts: ArtifactSource;
  /** HUSHD_POLICY_WALLET_KEY (an OutLayer wallet key), else HUSHD_NEAR_ACCOUNT with HUSHD_NEAR_PRIVATE_KEY. */
  near: NearAccount | null;
  /** Refuse spending while the owner has frozen the policy wallet (read on chain, cached 15 seconds). */
  assertNotFrozen(): Promise<void>;
}

async function nearAccount(env: Env, net: HushdNetwork): Promise<NearAccount | null> {
  if (env.HUSHD_POLICY_WALLET_KEY) {
    const client = new CustodyWallet(env.HUSHD_POLICY_WALLET_KEY, env.HUSHD_CUSTODY_URL ?? CUSTODY[net.id].api);
    const a = await client.address();
    return { accountId: a.accountId, kind: "policy-wallet", wallet: { client, pubkey: a.publicKey }, call: async (c) => (await client.call(c)).txHash };
  }
  if (!env.HUSHD_NEAR_ACCOUNT || !env.HUSHD_NEAR_PRIVATE_KEY) return null;
  const accountId = env.HUSHD_NEAR_ACCOUNT;
  keepRpcErrorBodies(net.rpc);
  const near = new Near({ network: { networkId: net.id, rpcUrl: sendEndpoints(net)[0]! }, privateKey: env.HUSHD_NEAR_PRIVATE_KEY as `ed25519:${string}`, defaultSignerId: accountId });
  return {
    accountId,
    kind: "key",
    call: async (c) => {
      const out = (await near
        .transaction(accountId)
        .functionCall(c.receiver, c.method, c.args, { gas: `${Number(c.gas)}`, attachedDeposit: c.deposit })
        .send({ waitUntil: "EXECUTED_OPTIMISTIC" })) as unknown as { transaction?: { hash?: string }; status?: { Failure?: unknown } };
      if (out.status?.Failure) throw new Error(`${c.receiver}.${c.method} failed: ${JSON.stringify(out.status.Failure)}`);
      return out.transaction?.hash ?? "";
    },
  };
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
  const limits = new Limits(net, parseCaps(net, env.HUSHD_LIMIT_PER_PAYMENT ?? DEFAULT_PER_PAYMENT), parseCaps(net, env.HUSHD_LIMIT_PER_DAY ?? DEFAULT_PER_DAY), join(homeDir(env), `${net.id}-${tag}.spent.json`), undefined, parseRules(env));
  const near = await nearAccount(env, net);
  let frozenAt = { at: 0, frozen: false };
  const assertNotFrozen = async () => {
    if (!near?.wallet) return;
    if (Date.now() - frozenAt.at > 15_000) frozenAt = { at: Date.now(), frozen: !!(await custodyView.policy(net, near.wallet.pubkey))?.frozen };
    if (frozenAt.frozen) throw new Error("The owner froze this agent's policy wallet, so it may not spend until the owner unfreezes it");
  };
  return { net, id, wallet, relayer, api: new DeskApi(net.api), limits, artifacts, near, assertNotFrozen };
}
