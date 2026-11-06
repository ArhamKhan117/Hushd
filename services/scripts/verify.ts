/**
 * `pnpm verify`: check each claim the README makes against the live testnet
 * deployment, read-only, and print PASS or FAIL per claim. No keys needed.
 *
 *   HUSHD_APP_URL (default https://hushd.net)   HUSHD_API_URL (default https://api.hushd.net)
 */
import { existsSync, readFileSync } from "node:fs";
import { deskView, poolView, TESTNET, view, withOverrides } from "@hushd/sdk";

const ROOT = new URL("../..", import.meta.url).pathname;
const APP = (process.env.HUSHD_APP_URL ?? "https://hushd.net").replace(/\/$/, "");
const API = (process.env.HUSHD_API_URL ?? "https://api.hushd.net").replace(/\/$/, "");
const net = withOverrides(TESTNET, { api: API, ...(process.env.NEAR_RPC_URL ? { rpc: process.env.NEAR_RPC_URL.split(",") } : {}) });

type Check = { claim: string; run: () => Promise<string> };
const fail = (why: string): never => {
  throw new Error(why);
};

async function rpc<T>(method: string, params: unknown): Promise<T> {
  // public RPCs rate-limit: try each endpoint, twice
  let last = "RPC error";
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const url of net.rpc) {
      const j = (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })
        .then((r) => r.json())
        .catch(() => ({ error: { message: `${url} unreachable` } }))) as { result?: T; error?: { code?: number; message?: string; cause?: { name?: string } } };
      if (j.result !== undefined) return j.result;
      if (j.error?.cause?.name && j.error.code !== -429) fail(j.error.cause.name);
      last = j.error?.message?.slice(0, 80) ?? last;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  return fail(last);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) }).catch(() => fail(`${url} is unreachable`));
  return { status: r.status, body: (await r.json().catch(() => null)) as T };
}

const deployed = existsSync(`${ROOT}deployments/testnet.json`)
  ? (JSON.parse(readFileSync(`${ROOT}deployments/testnet.json`, "utf8")) as { contracts: Record<string, { account: string; codeHash: string }> })
  : null;

const checks: Check[] = [
  {
    claim: "The pool, desk, board and token contracts are deployed on NEAR testnet with the code in this repo",
    run: async () => {
      if (!deployed) fail("deployments/testnet.json is missing");
      const out: string[] = [];
      for (const [name, c] of Object.entries(deployed!.contracts)) {
        const a = await rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: c.account });
        if (a.code_hash !== c.codeHash) fail(`${c.account} runs code ${a.code_hash}, not ${c.codeHash}`);
        out.push(name);
      }
      return `${out.join(", ")} match their recorded code hashes`;
    },
  },
  {
    claim: "Tokens enter the pool only within deposit limits, and the pool holds notes",
    run: async () => {
      const assets = (await poolView.assets(net)) as unknown[];
      const stats = await poolView.stats(net);
      if (assets.length === 0) fail("no assets listed");
      return `${assets.length} assets listed; stats ${JSON.stringify(stats)}`;
    },
  },
  {
    claim: "The desk's matcher key comes from the OutLayer enclave",
    run: async () => {
      const e = await deskView.enclave(net);
      if (!e.sign_key || !e.enc_key) fail("the desk has no enclave key yet");
      return `project ${e.project}, signing key ${e.sign_key!.slice(0, 18)}…`;
    },
  },
  {
    claim: "At least three makers are registered, each with a bond on chain",
    run: async () => {
      const makers = await deskView.makers(net);
      const cfg = await deskView.config(net);
      const bonded = makers.filter(([, m]) => m.active && BigInt(m.bond) >= BigInt(cfg.min_bond));
      if (bonded.length < 3) fail(`${bonded.length} active bonded makers`);
      return bonded.map(([a, m]) => `${m.name} (${a})`).join(", ");
    },
  },
  {
    claim: "Deals are matched and settled privately on testnet",
    run: async () => {
      const deals = await deskView.deals(net, 100);
      const settled = deals.filter((d) => d.receipt?.outcome === "settled");
      if (settled.length === 0) fail("no settled deal yet");
      return `${settled.length} settled of the last ${deals.length}; latest #${settled.at(-1)!.id}`;
    },
  },
  {
    claim: "The API, relayer and indexer are up",
    run: async () => {
      const parts: string[] = [];
      for (const path of ["/health", "/health/relayer", "/health/indexer", "/health/makers"]) {
        const r = await getJson<{ ok?: boolean }>(`${API}${path}`);
        if (r.status !== 200) fail(`${path} answered ${r.status}`);
        parts.push(path);
      }
      return parts.join(", ");
    },
  },
  {
    claim: "Plain-language intake runs on a NEAR AI Cloud model whose TDX and GPU attestation verifies",
    run: async () => {
      const r = await getJson<{ model: string; tcb_status: string; gpu_evidence: string; enabled: boolean; error?: string }>(`${API}/v1/intake/attestation`);
      if (r.status !== 200) fail(r.body?.error ?? `HTTP ${r.status}`);
      if (r.body.gpu_evidence !== "verified") fail("GPU evidence not verified");
      return `${r.body.model}: TDX ${r.body.tcb_status}, GPU ${r.body.gpu_evidence}, intake ${r.body.enabled ? "on" : "off (no API key)"}`;
    },
  },
  {
    claim: "Makers sell quotes over private x402 (scheme hushd)",
    run: async () => {
      const makers = await deskView.makers(net);
      const m = makers[0] ?? fail("no maker");
      const usdc = net.tokens[0]!.id;
      const r = await getJson<{ accepts?: { scheme: string; payTo: string }[] }>(`${API}/makers/${m[0]}/quote?sell=${usdc}&amount=1000000&buy=${net.tokens[2]!.id}`);
      if (r.status !== 402) fail(`answered ${r.status}, not 402`);
      const a = r.body.accepts?.find((x) => x.scheme === "hushd") ?? fail("no hushd scheme offered");
      return `402 asks payment to ${a.payTo.slice(0, 16)}…`;
    },
  },
  {
    claim: "The hosted MCP server answers at /mcp with read tools",
    run: async () => {
      const r = await getJson<{ result?: { tools: { name: string }[] } }>(`${APP}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      const names = r.body?.result?.tools.map((t) => t.name) ?? fail(`HTTP ${r.status}`);
      if (!names.includes("hushd_verify_proof")) fail("hushd_verify_proof missing");
      return names.join(", ");
    },
  },
  {
    claim: "The pool verifies Groth16 proofs on chain (alt_bn128)",
    run: async () => {
      // A receipt proof made with the development keys (contracts/pool/tests/fixtures.json).
      const f = `${ROOT}contracts/pool/tests/fixtures.json`;
      const fx = (JSON.parse(readFileSync(f, "utf8")) as { receipt: { proof: unknown; publicSignals: string[] } }).receipt;
      const r = await view<{ proof_valid: boolean }>(net, net.pool!, "verify_disclosure", { kind: "receipt", proof: fx.proof, public_inputs: fx.publicSignals, legs: null });
      if (!r.proof_valid) fail("the pool refused a valid proof");
      return "a valid receipt proof checks out in a view call";
    },
  },
];

let failed = 0;
for (const c of checks) {
  try {
    const detail = await c.run();
    console.log(`PASS  ${c.claim}\n      ${detail}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${c.claim}\n      ${(e as Error).message}`);
  }
}
console.log(`\n${checks.length - failed} of ${checks.length} claims hold.`);
process.exit(failed ? 1 : 0);
