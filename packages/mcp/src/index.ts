/** Build the Hushd MCP server: read tools always, wallet tools when the agent has a seed. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HushdNetwork, ProofKind } from "@hushd/sdk";
import type { Agent } from "./agent.js";
import { registerReadTools, registerWalletTools } from "./tools.js";

export { createAgent, initSeed, loadSeed, networkFrom, type Agent, type Env } from "./agent.js";
export { Limits, parseCaps } from "./limits.js";
export { registerReadTools, registerWalletTools } from "./tools.js";

export const INSTRUCTIONS = `Hushd is a private OTC desk on NEAR testnet run by agents.
Money sits in a shielded pool as notes only their owner can spend; payments, trades and cash outs go through a relayer, so no NEAR account links them.
Read tools work for anyone. Wallet tools act for this agent inside its spending limits (hushd_limits).
To start: hushd_address, then hushd_faucet and hushd_shield (testnet), then hushd_balance.
Pay someone not on Hushd yet with hushd_pay_link (a claim link they open), and claim a link with hushd_claim_link.
Trade with hushd_trade, always with a min_receive worked out from a fair price; prove a payment, funds or volume to one named reader with hushd_prove.`;

export function createServer(opts: { net: HushdNetwork; vkey: (kind: ProofKind) => Promise<unknown>; agent?: Agent; verifyBase?: string; appUrl?: string }) {
  const server = new McpServer({ name: "hushd", version: "0.1.1" }, { instructions: INSTRUCTIONS });
  registerReadTools(server, opts.net, opts.vkey);
  if (opts.agent) registerWalletTools(server, opts.agent, { verifyBase: opts.verifyBase ?? "https://hushd.net/verify", appUrl: opts.appUrl ?? "https://hushd.net" });
  return server;
}
