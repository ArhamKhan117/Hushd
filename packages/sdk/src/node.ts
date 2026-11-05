/**
 * Node-only helpers (agents, makers, the MCP server): an encrypted note store on disk
 * and proving artifacts fetched once and checked against the published manifest.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactSource } from "./prove.js";
import type { NoteStore, WalletState } from "./wallet.js";

/** AES-256-GCM file store; the key comes from the wallet seed, so the file alone reveals nothing. */
export class EncryptedFileStore implements NoteStore {
  private readonly key: Buffer;
  constructor(private readonly path: string, seed: Uint8Array) {
    this.key = createHash("sha256").update("hushd.store.v1").update(seed).digest();
  }
  async load(): Promise<WalletState | null> {
    if (!existsSync(this.path)) return null;
    const raw = readFileSync(this.path);
    const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8")) as WalletState;
  }
  async save(state: WalletState): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(state), "utf8"), c.final()]);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), body]), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

/**
 * Proving artifacts from a local directory, or downloaded once from `baseUrl` into
 * `cacheDir` and checked against `manifest.json` (sha256 per file).
 */
export async function cachedArtifacts(opts: { dir?: string; baseUrl?: string; cacheDir: string }): Promise<ArtifactSource> {
  if (opts.dir) return { wasm: (n) => join(opts.dir!, `${n}.wasm`), zkey: (n) => join(opts.dir!, `${n}.zkey`) };
  const base = (opts.baseUrl ?? "https://hushd.net/circuits").replace(/\/$/, "");
  const manifest = (await (await fetch(`${base}/manifest.json`)).json()) as { files: Record<string, string> };
  mkdirSync(opts.cacheDir, { recursive: true });
  const get = async (file: string) => {
    const want = manifest.files[file];
    if (!want) throw new Error(`${file} is not in the artifact manifest`);
    const path = join(opts.cacheDir, `${want.slice(0, 16)}-${file}`);
    if (!existsSync(path)) {
      const res = await fetch(`${base}/${file}`);
      if (!res.ok) throw new Error(`Could not download ${file}: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== want) throw new Error(`${file} does not match the manifest`);
      writeFileSync(path, bytes);
    }
    return path;
  };
  return { wasm: (n) => get(`${n}.wasm`), zkey: (n) => get(`${n}.zkey`) };
}
