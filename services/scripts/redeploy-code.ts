/**
 * Redeploy one contract's code on testnet without touching its state (the account holds
 * the deployer's key, added at deploy):
 *
 *   pnpm --filter @hushd/services exec tsx scripts/redeploy-code.ts desk
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { keepRpcErrorBodies, rpcOrder, sendEndpoints, TESTNET, withOverrides } from "@hushd/sdk";
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
const net = withOverrides(TESTNET, process.env.NEAR_RPC_URL ? { rpc: process.env.NEAR_RPC_URL.split(",") } : {});
const code = new Uint8Array(readFileSync(wasm));
// the deployed contracts name their commit and build image (NEP-330 build_info); keep it that way
if (!Buffer.from(code).includes("source_code_snapshot")) throw new Error(`${wasm} is not a reproducible build: run \`cargo near build reproducible-wasm\` in contracts/${wasmName} on a clean, committed tree`);
// a free endpoint may be rate-limiting this machine: try each, with the RPC's own reason when one refuses
keepRpcErrorBodies(net);
let out: { transaction?: { hash?: string } } | undefined;
for (const rpcUrl of rpcOrder(sendEndpoints(net))) {
  const near = new Near({ network: { networkId: "testnet", rpcUrl }, privateKey: key as `ed25519:${string}`, defaultSignerId: account, defaultWaitUntil: "FINAL" });
  try {
    out = (await near.transaction(account).deployContract(account, code).send()) as unknown as { transaction?: { hash?: string } };
    break;
  } catch (e) {
    console.error(`${rpcUrl}: ${(e as Error)?.message ?? String(e)}`);
  }
}
if (!out) throw new Error(`no endpoint took the deploy of ${account}`);
const tx = out.transaction?.hash ?? "";
// the recorded hash is what `pnpm verify` holds the deployed code to
const file = join(ROOT, "deployments/testnet.json");
const record = JSON.parse(readFileSync(file, "utf8")) as { contracts: Record<string, { codeHash: string; redeployed?: string }> };
const entry = record.contracts[name];
if (entry) {
  entry.codeHash = base58.encode(sha256(code));
  entry.redeployed = tx;
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
}
console.log(`redeployed ${account}: ${tx} (code ${base58.encode(sha256(code))})`);
