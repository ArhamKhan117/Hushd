#!/usr/bin/env node
/**
 * Publish the browser proving artifacts to app/public/circuits: for each circuit its
 * witness generator (.wasm), final proving key (.zkey) and verification key (.json),
 * plus manifest.json with the sha256 of every file, which the app checks before proving.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "../app/public/circuits");
mkdirSync(dest, { recursive: true });
const manifest = { keys: "testnet (dev)", files: {} };
for (const name of ["joinsplit", "receipt", "funds", "volume"]) {
  const b = join(root, "build", name);
  const files = [
    [join(b, `${name}_js`, `${name}.wasm`), `${name}.wasm`],
    [join(b, `${name}_final.zkey`), `${name}.zkey`],
    [join(b, `${name}_vkey.json`), `${name}.vkey.json`],
  ];
  for (const [from, to] of files) {
    copyFileSync(from, join(dest, to));
    manifest.files[to] = createHash("sha256").update(readFileSync(from)).digest("hex");
  }
}
writeFileSync(join(dest, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`published ${Object.keys(manifest.files).length} files to app/public/circuits`);
