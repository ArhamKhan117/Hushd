#!/usr/bin/env node
/**
 * Compile every circuit with circom 2 (`--O2`) into build/<circuit>/: r1cs, wasm witness
 * generator and symbols. Needs `circom` on PATH (cargo install --git https://github.com/iden3/circom).
 *
 *   node scripts/compile.mjs [circuit ...]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALL = ["joinsplit", "receipt", "funds", "volume"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const name of wanted) {
  const out = join(root, "build", name);
  mkdirSync(out, { recursive: true });
  const log = execFileSync("circom", [join(root, name, `${name}.circom`), "--O2", "--r1cs", "--wasm", "--sym", "-o", out, "-l", join(root, "node_modules")], { encoding: "utf8" });
  const constraints = log.match(/non-linear constraints: (\d+)/)?.[1];
  console.log(`${name}: ${constraints} constraints`);
}
