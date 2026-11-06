/**
 * Redeploy one contract's code on testnet without touching its state (the account holds
 * the deployer's key, added at deploy):
 *
 *   pnpm --filter @hushd/services exec tsx scripts/redeploy-code.ts desk
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";

const ROOT = new URL("../..", import.meta.url).pathname;
const DEPLOYER = process.env.DEPLOYER_ACCOUNT ?? "hushd.testnet";
const name = process.argv[2];
if (!name || !/^[a-z]+$/.test(name)) throw new Error("usage: redeploy-code.ts <pool|desk|board|token>");
const wasmName = ["usdc", "wnear", "btc"].includes(name) ? "token" : name;
const wasm = join(ROOT, "contracts/target/near", `hushd_${wasmName}`, `hushd_${wasmName}.wasm`);
if (!existsSync(wasm)) throw new Error(`${wasm} is missing: build it first`);
const key = process.env.DEPLOYER_PRIVATE_KEY ?? (JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${DEPLOYER}.json`), "utf8")) as { private_key: string }).private_key;
const account = `${name}.${DEPLOYER}`;
const near = new Near({ network: { networkId: "testnet", rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" }, privateKey: key as `ed25519:${string}`, defaultSignerId: account, defaultWaitUntil: "FINAL" });
const out = (await near.transaction(account).deployContract(account, new Uint8Array(readFileSync(wasm))).send()) as unknown as { transaction?: { hash?: string } };
console.log(`redeployed ${account}: ${out.transaction?.hash ?? ""}`);
