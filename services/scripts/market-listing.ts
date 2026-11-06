/**
 * Hushd's listing on NEAR's Agent Market (market.near.ai). Prepared here; registering and
 * going live create a public listing on mainnet, so they run only with the owner's go-ahead.
 *
 *   tsx scripts/market-listing.ts                          # print the listing and the calls it would make
 *   tsx scripts/market-listing.ts --try "sell 2500 USDC for NEAR"   # run one price check, as a hire would
 *   tsx scripts/market-listing.ts --register [--email you@example.com]   # owner's go-ahead: claim the handle, token to .env
 *   tsx scripts/market-listing.ts --live                   # owner's go-ahead: description, pricing plan, live
 *
 * After --register the worker (`src/main.ts market`) answers hires with its token.
 * A self-registered agent cannot withdraw: `--adopt` prints the one-time link that hands it to its owner.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../..", import.meta.url).pathname;
const ENV = join(ROOT, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);
const BASE = (process.env.MARKET_URL ?? "https://market.near.ai").replace(/\/$/, "");
const LISTING = JSON.parse(readFileSync(join(ROOT, "deploy/agent-market/listing.json"), "utf8")) as {
  handle: string;
  name: string;
  category: string;
  description: string;
  tags: string[];
  sla_seconds: number;
  bio_markdown_file: string;
  pricing: { model: "per_call"; price_amount: string; display_name: string; description: string; sla_seconds: number };
};
const bio = () => readFileSync(join(ROOT, "deploy/agent-market", LISTING.bio_markdown_file), "utf8");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : null;
};

async function call<T>(method: string, path: string, body?: unknown, token = process.env.MARKET_AGENT_TOKEN): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} answered ${r.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main() {
  const tryText = arg("try");
  if (tryText !== null) {
    const { tryPriceCheck } = await import("../src/market-agent.js");
    console.log(await tryPriceCheck(tryText));
    process.exit(0);
  }
  if (process.argv.includes("--register")) {
    if (process.env.MARKET_AGENT_TOKEN) throw new Error("MARKET_AGENT_TOKEN is already set: the listing exists");
    const email = arg("email");
    const r = await call<{ agentId: string; handle: string; apiToken: string }>("POST", "/v1/agents/register", { handle: LISTING.handle, name: LISTING.name, category: LISTING.category, sla_seconds: LISTING.sla_seconds, ...(email ? { email } : {}) }, "");
    // the token is shown once: keep it before anything else
    appendFileSync(ENV, `MARKET_AGENT_TOKEN=${r.apiToken}\nMARKET_AGENT_ID=${r.agentId}\n`);
    console.log(`registered ${r.handle} (${r.agentId}); token saved to .env as MARKET_AGENT_TOKEN`);
    return;
  }
  if (process.argv.includes("--live")) {
    const id = process.env.MARKET_AGENT_ID ?? "";
    if (!process.env.MARKET_AGENT_TOKEN || !id) throw new Error("register first (--register)");
    await call("PATCH", `/v1/agents/${id}`, { description: LISTING.description, bio_markdown: bio(), tags: LISTING.tags, category: LISTING.category, sla_seconds: LISTING.sla_seconds });
    const plans = await call<{ id: string }[]>("GET", `/v1/agents/${id}/pricing-plans`);
    if (plans.length === 0) await call("POST", `/v1/agents/${id}/pricing-plans`, LISTING.pricing);
    await call("PATCH", `/v1/agents/${id}`, { listing_status: "live" });
    console.log(`live: https://${LISTING.handle}.${new URL(BASE).host}/.well-known/agent-card.json`);
    return;
  }
  if (process.argv.includes("--adopt")) {
    console.log(await call("POST", "/v1/agents/me/adoption-code", {}));
    return;
  }
  console.log(`Listing on ${BASE} (nothing is sent without --register or --live):\n`);
  console.log(JSON.stringify({ ...LISTING, bio_markdown: `${bio().slice(0, 240)}…` }, null, 2));
  console.log(`\nCalls, in order:
  1. POST /v1/agents/register {handle: "${LISTING.handle}", name, category: "${LISTING.category}"}  -> aat_ token (shown once), to .env
  2. PATCH /v1/agents/{id} {description, bio_markdown, tags}
  3. POST /v1/agents/{id}/pricing-plans ${JSON.stringify(LISTING.pricing)}
  4. PATCH /v1/agents/{id} {listing_status: "live"}
  5. the worker (src/main.ts market) polls GET /v1/agents/me/assignments and submits each report
Its card would be https://${LISTING.handle}.${new URL(BASE).host}/.well-known/agent-card.json; payments are real USDC on mainnet (5% platform fee).`);
}

main().catch((e) => {
  console.error("market-listing:", (e as Error).message);
  process.exit(1);
});
