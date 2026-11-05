#!/usr/bin/env node
/**
 * hushd-mcp: the Hushd MCP server over stdio.
 *
 *   hushd-mcp init     write a new agent seed to ~/.hushd/seed (mode 600)
 *   hushd-mcp          serve (read-only without a seed)
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProofKind } from "@hushd/sdk";
import { createAgent, initSeed, loadSeed, networkFrom } from "./agent.js";
import { createServer } from "./index.js";

const env = { ...process.env };
// Inside a checkout of the repo, prove with the app's published artifacts.
const repoCircuits = join(import.meta.dirname, "../../../app/public/circuits");
if (!env.HUSHD_CIRCUITS_DIR && !env.HUSHD_CIRCUITS_URL && existsSync(join(repoCircuits, "manifest.json"))) env.HUSHD_CIRCUITS_DIR = repoCircuits;

async function main() {
  if (process.argv[2] === "init") {
    const r = initSeed(env);
    console.log(r.created ? `New agent seed written to ${r.path}. Keep it secret: it spends this agent's private balance.` : `A seed already exists at ${r.path}.`);
    return;
  }
  const net = networkFrom(env);
  const seed = loadSeed(env);
  const circuitsUrl = (env.HUSHD_CIRCUITS_URL ?? "https://hushd.net/circuits").replace(/\/$/, "");
  const vkey = async (kind: ProofKind) =>
    env.HUSHD_CIRCUITS_DIR ? JSON.parse(await readFile(join(env.HUSHD_CIRCUITS_DIR, `${kind}.vkey.json`), "utf8")) : (await fetch(`${circuitsUrl}/${kind}.vkey.json`)).json();
  const agent = seed ? await createAgent(env, seed) : undefined;
  if (!agent) console.error("hushd-mcp: no seed (run `hushd-mcp init`, or `pnpm mcp init` in the repo, or set HUSHD_SEED); serving read-only tools.");
  const server = createServer({ net, vkey, ...(agent ? { agent } : {}), verifyBase: env.HUSHD_VERIFY_URL ?? "https://hushd.net/verify" });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("hushd-mcp:", (e as Error).message);
  process.exit(1);
});
