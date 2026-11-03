#!/usr/bin/env node
/**
 * Testnet ("dev") Groth16 keys for every Hushd circuit.
 *
 *   1. Powers of Tau: the public Perpetual Powers of Tau (PSE), 2^16, file
 *      build/ptau/pot16.ptau (sha256 below).
 *   2. Phase 2, per circuit: one contribution with 64 bytes of fresh random
 *      entropy that this script never writes down, then a public beacon: the hash
 *      of a NEAR mainnet block named below, 2^10 iterations.
 *
 * Whoever runs this could have kept the entropy (it lives in memory only, but
 * nobody else can check that), so these keys are for testnet only. Mainnet needs a
 * multi-party ceremony. The transcript (every hash) goes to circuits/KEYS.md.
 *
 *   node scripts/setup-dev-keys.mjs [circuit ...]
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = here.endsWith("scripts") ? join(here, "..") : here;
const build = join(root, "build");
const PTAU = join(build, "ptau/pot16.ptau");
const PTAU_SHA256 = "ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9";
const BEACON = {
  network: "NEAR mainnet",
  height: 223247205,
  hashBase58: "8kJ7Q27wWASLGamyz9Tq56mKhtRKvzAuSwPkyZBAzQdu",
  iterationsExp: 10,
};
const ALL = ["joinsplit", "receipt", "funds", "volume"];

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58ToHex(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(64, "0");
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error };

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
if (sha256(PTAU) !== PTAU_SHA256) throw new Error("pot16.ptau is not the expected Perpetual Powers of Tau file");

const transcript = [];
for (const name of wanted) {
  const dir = join(build, name);
  const r1cs = join(dir, `${name}.r1cs`);
  if (!existsSync(r1cs)) throw new Error(`compile ${name} first (npm run compile)`);
  const z0 = join(dir, `${name}_0.zkey`);
  const z1 = join(dir, `${name}_1.zkey`);
  const zf = join(dir, `${name}_final.zkey`);

  await snarkjs.zKey.newZKey(r1cs, PTAU, z0, quiet);
  const entropy = randomBytes(64).toString("hex");
  const contribution = await snarkjs.zKey.contribute(z0, z1, "hushd testnet", entropy, quiet);
  await snarkjs.zKey.beacon(z1, zf, "NEAR mainnet block beacon", base58ToHex(BEACON.hashBase58), BEACON.iterationsExp, quiet);
  const ok = await snarkjs.zKey.verifyFromR1cs(r1cs, PTAU, zf, quiet);
  if (!ok) throw new Error(`${name}: the final key does not verify against the r1cs and ptau`);
  const vkey = await snarkjs.zKey.exportVerificationKey(zf);
  writeFileSync(join(dir, `${name}_vkey.json`), JSON.stringify(vkey, null, 1));

  const info = await snarkjs.r1cs.info(r1cs, quiet);
  transcript.push({
    circuit: name,
    constraints: info.nConstraints,
    publicInputs: info.nPubInputs,
    r1csSha256: sha256(r1cs),
    contributionHash: Buffer.from(contribution).toString("hex"),
    finalZkeySha256: sha256(zf),
  });
  console.log(`${name}: ${info.nConstraints} constraints, final key ${sha256(zf).slice(0, 16)}…`);
}
writeFileSync(join(build, "keys-transcript.json"), JSON.stringify({ ptauSha256: PTAU_SHA256, beacon: BEACON, circuits: transcript }, null, 2));
process.exit(0);
