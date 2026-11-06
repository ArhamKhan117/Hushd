/**
 * Hushd's trader agent on the NEAR Intents Agent API (mainnet only, real funds; a partner key
 * from partners.near-intents.org in NEAR_INTENTS_AGENT_API_KEY). The mainnet demo's dev wallet
 * owns the agent and signs its policy; the agent swaps and withdraws inside that policy with a
 * grant, and the owner can freeze it.
 *
 *   pnpm --filter @hushd/services agent-api              # status; with a key: who we are and the policy the owner would sign. Sends nothing
 *   pnpm --filter @hushd/services agent-api --create     # owner's go-ahead: create the agent (the API's sponsor sends the owner's delegate action)
 *   pnpm --filter @hushd/services agent-api --grant      # a grant for this backend; its token goes to .env
 *   pnpm --filter @hushd/services agent-api --deposit    # the agent's deposit address for wNEAR
 *   pnpm --filter @hushd/services agent-api --swap-dry   # quote 0.1 wNEAR to USDC inside the policy (moves nothing)
 *   pnpm --filter @hushd/services agent-api --freeze | --unfreeze
 *
 * The policy: swap, transfer and withdraw only wNEAR and USDC, at most 0.2 wNEAR or 1 USDC a
 * transaction and 3 USD a day, transfers only to the demo's maker agent and withdrawals only to
 * the dev wallet.
 */
import { appendFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { accountBalance, implicitAccount, MAINNET } from "@hushd/sdk";
import { AGENT_API_USDC, AGENT_API_WNEAR, agentApi, hushdAgentPolicy, ownerAction, ownerKey, ownerWallet } from "../src/agent-api.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const ENV = join(ROOT, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);
const flag = (f: string) => process.argv.includes(`--${f}`);

function secret(name: string): Uint8Array {
  if (!process.env[name]) {
    const hex = randomBytes(32).toString("hex");
    appendFileSync(ENV, `${name}=${hex}\n`);
    process.env[name] = hex;
  }
  return Uint8Array.from(Buffer.from(process.env[name]!, "hex"));
}

function remember(name: string, value: string) {
  appendFileSync(ENV, `${name}=${value}\n`);
  process.env[name] = value;
}

async function main() {
  const owner = ownerKey(secret("INTENTS_DEV_SECRET"));
  const makerAgent = implicitAccount(secret("INTENTS_MAKER_SECRET"));
  const policy = hushdAgentPolicy({
    transferTo: [makerAgent],
    withdrawTo: [owner.accountId],
    dailyUsd: "3",
    perTransaction: { [AGENT_API_WNEAR]: "200000000000000000000000", [AGENT_API_USDC]: "1000000" },
  });
  // the partner portal's one key serves 1Click and the Agent API
  const key = process.env.NEAR_INTENTS_AGENT_API_KEY || process.env.ONECLICK_API_KEY || "";
  const api = await agentApi(key || "none", process.env.NEAR_INTENTS_AGENT_API_URL);
  const agentId = process.env.AGENT_API_TRADER_ID;

  const network = await api.getNetwork();
  console.log(`Agent API on ${network.network} (${network.contract_id}): ${network.status.overall}`);
  const tokens = await api.getTokens();
  for (const id of [AGENT_API_WNEAR, AGENT_API_USDC]) if (!tokens.some((t) => t.asset_id === id)) throw new Error(`${id} is not an Agent API asset`);
  console.log(`owner: ${owner.accountId} (the mainnet demo's dev wallet); transfers only to ${makerAgent}`);

  if (!key) {
    console.log(`\nNo NEAR_INTENTS_AGENT_API_KEY: nothing else to do. The policy the owner would sign:\n${JSON.stringify(policy, null, 2)}`);
    return;
  }
  const me = await api.whoami();
  console.log(`partner: ${JSON.stringify(me)}`);

  if (flag("create")) {
    if (agentId) throw new Error(`AGENT_API_TRADER_ID is already set (${agentId})`);
    if ((await accountBalance(MAINNET, owner.accountId)) === null) throw new Error("The dev wallet does not exist on mainnet yet: fund it first");
    const generated = await api.generateIntent({ type: "agent_create", name: "Hushd trader", owner: ownerWallet(owner), policy });
    console.log(generated.preview.summary);
    // the id is known before the owner signs: keep it first, so a crash cannot lose the agent
    remember("AGENT_API_TRADER_ID", generated.agent_id);
    await ownerAction(api, owner, MAINNET, generated);
    console.log(`created ${generated.agent_id}; wallet ${JSON.stringify(await api.getWallet(generated.agent_id))}`);
    return;
  }
  if (!agentId) {
    console.log(`\nNo agent yet. --create makes it under this policy:\n${JSON.stringify(policy, null, 2)}`);
    return;
  }
  if (flag("grant")) {
    const { createGrantCredential } = await import("@near-intents-agent-api/sdk");
    const { token, commitment } = createGrantCredential();
    const generated = await api.generateIntent({ type: "grant_issue", agent_id: agentId, label: "Hushd backend", credential: commitment, expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    remember("AGENT_API_TRADER_GRANT", token);
    await ownerAction(api, owner, MAINNET, generated);
    console.log("grant issued; its token is in .env as AGENT_API_TRADER_GRANT");
    return;
  }
  if (flag("freeze") || flag("unfreeze")) {
    const type = flag("freeze") ? "agent_freeze" : "agent_unfreeze";
    await ownerAction(api, owner, MAINNET, await api.generateIntent({ type, agent_id: agentId }));
    console.log(`${type}: done`);
    return;
  }
  if (flag("deposit")) {
    const d = await api.deposit(agentId, { origin_asset: AGENT_API_WNEAR, confidential: false });
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  if (flag("swap-dry")) {
    const grant = process.env.AGENT_API_TRADER_GRANT;
    if (!grant) throw new Error("No grant yet: --grant first");
    const quote = await api.forGrant(grant).swap(agentId, { origin_asset: AGENT_API_WNEAR, destination_asset: AGENT_API_USDC, amount: "100000000000000000000000", dry: true });
    console.log(JSON.stringify(quote, null, 2));
    return;
  }
  console.log(JSON.stringify({ agent: await api.getAgent(agentId), policy: await api.getPolicy(agentId), balances: await api.getBalances(agentId) }, null, 2));
}

main().catch((e) => {
  const err = e as { code?: string; message: string; layer?: string };
  console.error("agent-api:", err.code ? `${err.code} (${err.layer ?? "api"}): ${err.message}` : err.message);
  process.exit(1);
});
