/**
 * `pnpm verify`: check the README's live claims against the testnet deployment,
 * read-only, and print PASS or FAIL per claim. No keys needed.
 *
 *   HUSHD_APP_URL (default https://hushd.net)   HUSHD_API_URL (default https://api.hushd.net)
 */
import { existsSync, readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { ed25519 } from "@noble/curves/ed25519.js";
import { custodyView, decodeProof, deskView, implicitAccount, INTENTS_MAINNET, intake, MAINNET, poolView, rpcOrder, signIntents, TESTNET, tradeDiffs, verifierView, view, withOverrides } from "@hushd/sdk";

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
    for (const url of rpcOrder(net.rpc)) {
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
  ? (JSON.parse(readFileSync(`${ROOT}deployments/testnet.json`, "utf8")) as { contracts: Record<string, { account: string; codeHash: string }>; policyWallets?: Record<string, { account: string; owner: string }> })
  : null;

const checks: Check[] = [
  {
    claim: "The pool, desk, board and token contracts on NEAR testnet run the recorded builds (and yours, if you built them reproducibly)",
    run: async () => {
      if (!deployed) fail("deployments/testnet.json is missing");
      const out: string[] = [];
      let local = 0;
      for (const [name, c] of Object.entries(deployed!.contracts)) {
        const a = await rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: c.account });
        if (a.code_hash !== c.codeHash) fail(`${c.account} runs code ${a.code_hash}, not the recorded ${c.codeHash}`);
        // only a reproducible build (`cargo near build reproducible-wasm`) embeds its commit and gives the same bytes
        const crate = ["usdc", "wnear", "btc"].includes(name) ? "token" : name;
        const wasm = `${ROOT}contracts/target/near/hushd_${crate}/hushd_${crate}.wasm`;
        if (existsSync(wasm) && readFileSync(wasm).includes("source_code_snapshot")) {
          const mine = base58.encode(sha256(readFileSync(wasm)));
          if (mine !== a.code_hash) fail(`${c.account} runs ${a.code_hash}; your reproducible build of ${crate} hashes to ${mine}`);
          local++;
        }
        out.push(name);
      }
      return `${out.join(", ")} match the recorded hashes${local ? `; ${local} also match your reproducible build` : " (`cargo near build reproducible-wasm` in a contract to compare with your own build)"}`;
    },
  },
  {
    claim: "Each contract names the commit and the Docker image it was built from (NEP-330), so anyone can rebuild it",
    run: async () => {
      if (!deployed) fail("deployments/testnet.json is missing");
      const revs = new Set<string>();
      for (const c of Object.values(deployed!.contracts)) {
        const meta = await view<{ link: string; build_info: { build_environment: string; source_code_snapshot: string; contract_path: string } | null }>(net, c.account, "contract_source_metadata");
        const b = meta.build_info;
        if (!b) fail(`${c.account} has no build_info: it was not built with \`cargo near build reproducible-wasm\``);
        if (!/^sourcescan\/cargo-near:[\w.-]+@sha256:[0-9a-f]{64}$/.test(b!.build_environment)) fail(`${c.account} names an unpinned build image: ${b!.build_environment}`);
        const rev = /^git\+https:\/\/github\.com\/ArhamKhan117\/Hushd\?rev=([0-9a-f]{40})$/.exec(b!.source_code_snapshot)?.[1];
        if (!rev) fail(`${c.account} names another source: ${b!.source_code_snapshot}`);
        revs.add(`${rev!.slice(0, 7)} (${b!.build_environment.split("@")[0]})`);
      }
      return `built from ${[...revs].join(", ")}; NearBlocks' Verify and Publish rebuilds them from the repository`;
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
      const latest = settled.reduce((a, d) => (Number(d.id) > Number(a.id) ? d : a));
      return `${settled.length} settled of the last ${deals.length}; latest #${latest.id}`;
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
    claim: "The indexer is caught up with the chain",
    run: async () => {
      const r = await getJson<{ source?: string; head: number; behind: number }>(`${API}/health/indexer`);
      if (r.status !== 200) fail(`HTTP ${r.status}`);
      if (r.body.behind > 30) fail(`${r.body.behind} blocks behind`);
      return `${r.body.behind} blocks behind at ${r.body.head} (${r.body.source ?? "blocks"})`;
    },
  },
  {
    claim: "Agents act through policy wallets: OutLayer custody wallets whose policy the owner controls on chain, and the makers' desk accounts are those wallets",
    run: async () => {
      const wallets = Object.entries(deployed?.policyWallets ?? {});
      if (wallets.length === 0) fail("no policy wallet in deployments/testnet.json");
      const out: string[] = [];
      for (const [prefix, w] of wallets) {
        const p = (await custodyView.policy(net, `ed25519:${w.account}`)) ?? fail(`${prefix}: no policy stored on ${net.outlayer}`);
        if (p.owner !== w.owner) fail(`${prefix}: the policy is controlled by ${p.owner}, not ${w.owner}`);
        if (prefix.startsWith("MAKER_")) {
          const m = (await deskView.makers(net)).find(([a]) => a === w.account) ?? fail(`${prefix}: ${w.account} is not a maker on the desk`);
          if (!m[1].active) fail(`${prefix}: not active on the desk`);
        }
        out.push(`${prefix.toLowerCase()} ${w.account.slice(0, 8)}… (${p.frozen ? "frozen" : "active"}, owner ${p.owner})`);
      }
      return out.join(", ");
    },
  },
  {
    claim: "A direct trade signed by two agents passes intents.near's checks on mainnet (simulate_intents, nothing sent)",
    run: async () => {
      const [a, b] = [ed25519.utils.randomSecretKey(), ed25519.utils.randomSecretKey()];
      const v = INTENTS_MAINNET.verifier;
      const [fee, salt] = [await verifierView.fee(MAINNET, v), await verifierView.salt(MAINNET, v)];
      const d = tradeDiffs({ give: { token: INTENTS_MAINNET.usdc.id, amount: 1_000_000n }, take: { token: INTENTS_MAINNET.wnear.id, amount: 3n * 10n ** 23n }, feePips: fee });
      const dl = Date.now() + 120_000;
      const signed = [
        signIntents({ signerId: implicitAccount(a), secret: a, verifier: v, salt, deadlineMs: dl, intents: [{ intent: "token_diff", diff: d.a }] }),
        signIntents({ signerId: implicitAccount(b), secret: b, verifier: v, salt, deadlineMs: dl, intents: [{ intent: "token_diff", diff: d.b }] }),
      ];
      // fresh agents hold nothing: the verifier checks signatures, keys and nonces, then stops at the balance
      const why = await verifierView.simulate(MAINNET, v, signed).then(() => "executed", (e: Error) => e.message);
      if (!/insufficient balance/.test(why)) fail(`intents.near answered: ${why}`);
      const done = existsSync(`${ROOT}deployments/mainnet-intents.json`) ? (JSON.parse(readFileSync(`${ROOT}deployments/mainnet-intents.json`, "utf8")) as { steps: { step: string; txs: string[] }[] }).steps.find((s) => s.step === "trade") : undefined;
      return `signatures, keys and nonces accepted (fee ${fee} pip, salt ${salt})${done ? `; mainnet trade ${done.txs[0]}` : "; the mainnet demo trade waits for the owner's go-ahead"}`;
    },
  },
  {
    claim: "The intake model signs its answer, and the signature checks out (NEAR AI Cloud, in a TEE)",
    run: async () => {
      const r = await intake(API, "Sell 1,000 USDC for BTC, at least 0.012 BTC").catch((e: Error) => fail(e.message.includes("402") ? "the NEAR AI Cloud account has no credits" : e.message));
      if (!r.proof.verified) fail("the response signature or its hashes do not check out");
      return `${r.proof.model} answered (${r.proof.signatureKind}, key ${r.proof.signingKey.slice(0, 12)}…): request and response hashes match, signature verified`;
    },
  },
  {
    claim: "The intake model's NEAR AI Cloud attestation (Intel TDX and NVIDIA GPU) verifies",
    run: async () => {
      const r = await getJson<{ model: string; tcb_status: string; gpu_evidence: string; enabled: boolean; error?: string }>(`${API}/v1/intake/attestation`);
      if (r.status !== 200) fail(r.body?.error ?? `HTTP ${r.status}`);
      if (r.body.gpu_evidence !== "verified") fail("GPU evidence not verified");
      return `${r.body.model}: TDX ${r.body.tcb_status}, GPU ${r.body.gpu_evidence}, intake ${r.body.enabled ? "on" : "off (no API key)"}`;
    },
  },
  {
    claim: "Makers ask for a private x402 payment (scheme hushd) before quoting",
    run: async () => {
      const makers = (await deskView.makers(net)).filter(([, x]) => x.active);
      const m = makers[0] ?? fail("no active maker");
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
    claim: "The pool verifies Groth16 proofs on chain (alt_bn128), with the reader and expiry they were made for",
    run: async () => {
      // the payment proof made for judge.testnet (deployments/judge-proof-payment.txt)
      const p = decodeProof(readFileSync(`${ROOT}deployments/judge-proof-payment.txt`, "utf8").trim());
      const r = await poolView.verifyDisclosure(net, p.kind, p.proof, p.publicSignals, p.legs, { network: p.network, reader: p.reader, expiresAtMs: p.expiresAtMs });
      if (!r.proof_valid) fail("the pool refused a valid proof");
      if (!r.chain_valid) fail(`the pool found: ${r.problems.join("; ")}`);
      const other = await poolView.verifyDisclosure(net, p.kind, p.proof, p.publicSignals, p.legs, { network: p.network, reader: "someone-else.testnet", expiresAtMs: p.expiresAtMs });
      if (other.chain_valid) fail("the pool accepted the proof for a reader it was not made for");
      return `${p.kind} proof for ${p.reader} holds on chain (deal #${r.deal_ids[0] ?? "?"}); the same proof for another reader does not`;
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
