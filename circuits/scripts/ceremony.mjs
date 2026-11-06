#!/usr/bin/env node
/**
 * The multi-party phase-2 ceremony that mainnet keys need. The development keys
 * (setup-dev-keys.mjs) have one contribution, so whoever ran it could forge proofs; here
 * every contributor adds randomness in turn, and the keys are safe if any one of them
 * threw theirs away. Same circuits, same public Perpetual Powers of Tau as the dev keys.
 *
 *   node scripts/ceremony.mjs start                      # coordinator: key 0000 per circuit from the r1cs and the ptau
 *   node scripts/ceremony.mjs contribute "<your name>"   # each contributor in turn, on their own machine, with the latest keys
 *   node scripts/ceremony.mjs verify                     # anyone: every contribution in the chain, against the r1cs and the ptau
 *   node scripts/ceremony.mjs finalize <height>          # coordinator: a public beacon, the hash of a NEAR mainnet block
 *                                                        # announced before it exists, then the final keys and vkeys
 *
 * State lives in build/ceremony (CEREMONY_DIR): `<circuit>/NNNN.zkey` and transcript.json.
 * A contributor gets the latest .zkey files and transcript.json from the coordinator, runs
 * `contribute`, sends the new files back and publishes the hashes it printed; anyone can
 * then check that their contribution is in the chain. The entropy is fresh random bytes
 * plus, if set, CEREMONY_ENTROPY (anything typed); neither is ever written down.
 *
 * `finalize --install` puts the final keys where setup-dev-keys.mjs puts its own
 * (build/<circuit>/<circuit>_final.zkey and _vkey.json); then `npm run publish-artifacts`
 * and `npm run vk`, rebuild the pool reproducibly and record the transcript in KEYS.md.
 * CEREMONY_CIRCUITS=receipt,funds limits a run (a rehearsal).
 */
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const build = join(root, "build");
const PTAU = join(build, "ptau/pot16.ptau");
const PTAU_SHA256 = "ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9";
const DIR = process.env.CEREMONY_DIR ?? join(build, "ceremony");
const CIRCUITS = (process.env.CEREMONY_CIRCUITS ?? "joinsplit,receipt,funds,volume").split(",").map((s) => s.trim()).filter(Boolean);
const NEAR_RPC = process.env.NEAR_MAINNET_RPC ?? "https://free.rpc.fastnear.com";
const BEACON_ITERATIONS_EXP = 10;

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const quiet = { debug() {}, info() {}, warn: console.warn, error: console.error };
const r1csOf = (c) => join(build, c, `${c}.r1cs`);
const pad = (n) => String(n).padStart(4, "0");
const transcriptPath = join(DIR, "transcript.json");
const readTranscript = () => (existsSync(transcriptPath) ? JSON.parse(readFileSync(transcriptPath, "utf8")) : null);
const writeTranscript = (t) => writeFileSync(transcriptPath, `${JSON.stringify(t, null, 2)}\n`);

function latest(circuit) {
  const files = readdirSync(join(DIR, circuit)).filter((f) => /^\d{4}\.zkey$/.test(f)).sort();
  if (!files.length) throw new Error(`no keys for ${circuit} in ${DIR}: run start first`);
  return { n: Number(files.at(-1).slice(0, 4)), path: join(DIR, circuit, files.at(-1)) };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58ToHex(s) {
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(64, "0");
}

async function start() {
  if (sha256(PTAU) !== PTAU_SHA256) throw new Error("pot16.ptau is not the expected Perpetual Powers of Tau file");
  if (readTranscript()) throw new Error(`${DIR} already holds a ceremony`);
  const t = { ptauSha256: PTAU_SHA256, circuits: {}, contributions: [] };
  for (const c of CIRCUITS) {
    if (!existsSync(r1csOf(c))) throw new Error(`compile ${c} first (npm run compile)`);
    mkdirSync(join(DIR, c), { recursive: true });
    await snarkjs.zKey.newZKey(r1csOf(c), PTAU, join(DIR, c, "0000.zkey"), quiet);
    t.circuits[c] = { r1csSha256: sha256(r1csOf(c)) };
    console.log(`${c}: key 0000 from ${c}.r1cs (${sha256(r1csOf(c)).slice(0, 16)}…)`);
  }
  writeTranscript(t);
  console.log(`\nSend ${DIR} to the first contributor.`);
}

async function contribute(name) {
  if (!name) throw new Error('contribute "<your name>"');
  const t = readTranscript();
  if (!t) throw new Error(`no ceremony in ${DIR}`);
  const hashes = {};
  for (const c of Object.keys(t.circuits)) {
    if (sha256(r1csOf(c)) !== t.circuits[c].r1csSha256) throw new Error(`${c}: your r1cs is not the ceremony's (compile the same commit)`);
    const prev = latest(c);
    const next = join(DIR, c, `${pad(prev.n + 1)}.zkey`);
    // fresh randomness every time, plus anything the contributor types; held in memory only
    const entropy = randomBytes(64).toString("hex") + (process.env.CEREMONY_ENTROPY ?? "");
    const h = await snarkjs.zKey.contribute(prev.path, next, name, entropy, quiet);
    hashes[c] = Buffer.from(h).toString("hex");
    console.log(`${c}: contribution ${pad(prev.n + 1)} ${hashes[c]}`);
  }
  t.contributions.push({ n: t.contributions.length + 1, name, at: new Date().toISOString(), hashes });
  writeTranscript(t);
  console.log("\nPublish these hashes somewhere you control, then send the new .zkey files and transcript.json back.");
}

async function verify() {
  const t = readTranscript();
  if (!t) throw new Error(`no ceremony in ${DIR}`);
  if (sha256(PTAU) !== t.ptauSha256) throw new Error("pot16.ptau is not the ceremony's");
  let ok = true;
  for (const c of Object.keys(t.circuits)) {
    const key = existsSync(join(DIR, c, "final.zkey")) ? join(DIR, c, "final.zkey") : latest(c).path;
    // checks every contribution in the key's own chain, back to the r1cs and the ptau
    const good = await snarkjs.zKey.verifyFromR1cs(r1csOf(c), PTAU, key, quiet);
    ok &&= good;
    console.log(`${c}: ${good ? "valid" : "INVALID"} (${key.split("/").slice(-1)[0]})`);
  }
  for (const k of t.contributions) console.log(`  ${k.n}. ${k.name}, ${k.at}`);
  if (t.beacon) console.log(`  beacon: NEAR mainnet block ${t.beacon.height} (${t.beacon.hash})`);
  if (!ok) process.exitCode = 1;
}

async function finalize(height, install) {
  const t = readTranscript();
  if (!t) throw new Error(`no ceremony in ${DIR}`);
  if (!Number.isInteger(height) || height <= 0) throw new Error("finalize <NEAR mainnet block height>");
  if (t.contributions.length < 2) throw new Error("a ceremony needs at least two independent contributors before the beacon");
  const r = await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "block", params: { block_id: height } }) }).then((x) => x.json());
  if (!r.result) throw new Error(`NEAR mainnet has no block ${height} yet (or it was skipped): ${JSON.stringify(r.error ?? r).slice(0, 200)}`);
  const hash = r.result.header.hash;
  t.beacon = { network: "NEAR mainnet", height, hash, iterationsExp: BEACON_ITERATIONS_EXP };
  t.final = {};
  for (const c of Object.keys(t.circuits)) {
    const fin = join(DIR, c, "final.zkey");
    await snarkjs.zKey.beacon(latest(c).path, fin, "NEAR mainnet block beacon", base58ToHex(hash), BEACON_ITERATIONS_EXP, quiet);
    if (!(await snarkjs.zKey.verifyFromR1cs(r1csOf(c), PTAU, fin, quiet))) throw new Error(`${c}: the final key does not verify`);
    const vkey = await snarkjs.zKey.exportVerificationKey(fin);
    writeFileSync(join(DIR, c, "vkey.json"), JSON.stringify(vkey, null, 1));
    t.final[c] = { zkeySha256: sha256(fin) };
    console.log(`${c}: final key ${sha256(fin).slice(0, 16)}…`);
    if (install) {
      copyFileSync(fin, join(build, c, `${c}_final.zkey`));
      copyFileSync(join(DIR, c, "vkey.json"), join(build, c, `${c}_vkey.json`));
    }
  }
  writeTranscript(t);
  console.log(install ? "\nInstalled: now npm run publish-artifacts, npm run vk, rebuild the pool reproducibly, and record transcript.json in KEYS.md." : "\nFinal keys are in the ceremony directory; --install puts them in build/.");
}

const [cmd, arg] = process.argv.slice(2);
const run = { start, contribute: () => contribute(arg), verify, finalize: () => finalize(Number(arg), process.argv.includes("--install")) }[cmd];
if (!run) {
  console.error("usage: ceremony.mjs start | contribute <name> | verify | finalize <height> [--install]");
  process.exit(2);
}
await run().catch((e) => {
  console.error(`ceremony: ${e.message}`);
  process.exitCode = 1;
});
// snarkjs keeps worker threads alive
process.exit(process.exitCode ?? 0);
