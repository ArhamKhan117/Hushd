/**
 * The hosted Hushd MCP server (Streamable HTTP, stateless): read tools only. It holds
 * no keys; an agent that pays or trades runs the MCP server from a checkout of the repo
 * (`pnpm mcp`) with its own seed. Its instructions name only the tools it serves, and a
 * plain GET (a browser, curl) gets a short note on how to connect instead of a 406.
 */
import { registerReadTools } from "@hushd/mcp";
import { singleThreadCurve, type ProofKind } from "@hushd/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NETWORK } from "@/lib/hushd/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The tools registerReadTools serves, in its order. */
const READ_TOOLS = ["hushd_status", "hushd_makers", "hushd_desk_deals", "hushd_deal", "hushd_verify_proof"] as const;

const INSTRUCTIONS = `Hushd is a private OTC desk on NEAR ${NETWORK.id}: money sits in a shielded pool as notes only their owner can spend, maker agents quote sealed requests, and both legs of a deal settle privately in one call.
This hosted server holds no keys and serves read tools only: ${READ_TOOLS.join(", ")}.
Use them to read the pool and the desk, list the makers, read deals and their receipts, and check a hushdproof1 proof.
To pay, trade, cash out or prove for an agent, run the Hushd MCP server next to it with its own seed and spending limits (pnpm mcp, from a checkout of https://github.com/ArhamKhan117/Hushd); see https://hushd.net/docs/agents.`;

const vkeys = new Map<string, unknown>();

async function handle(req: Request): Promise<Response> {
  const vkey = async (kind: ProofKind) => {
    if (!vkeys.has(kind)) vkeys.set(kind, await (await fetch(new URL(`/circuits/${kind}.vkey.json`, req.url))).json());
    return vkeys.get(kind);
  };
  await singleThreadCurve();
  const server = new McpServer({ name: "hushd", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  registerReadTools(server, NETWORK, vkey);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A short page for a browser: what this is and how to connect, in the site's graphite, light and dark. */
function page(url: string): string {
  const u = escape(url);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Hushd MCP server</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #0b0c0e; --mute: #5f636a; --line: #e4e6e9; --code: #f3f4f5; }
@media (prefers-color-scheme: dark) { :root { --bg: #08090a; --fg: #f4f5f6; --mute: #9b9fa6; --line: #232529; --code: #17181b; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 48px 16px; }
h1 { font-size: 24px; font-weight: 500; letter-spacing: -0.01em; margin: 0 0 12px; }
p { margin: 0 0 16px; color: var(--mute); }
pre { margin: 0 0 16px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--code); overflow-x: auto; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; }
code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--fg); }
.nw { white-space: nowrap; }
ul { margin: 0 0 16px; padding-left: 20px; color: var(--mute); }
a { color: var(--fg); text-underline-offset: 3px; }
</style>
</head>
<body>
<main>
<h1>Hushd MCP server</h1>
<p>This address is an MCP server for AI agents, not a web page. It speaks Streamable HTTP, holds no keys and serves read tools only, against NEAR ${escape(NETWORK.id)}:</p>
<ul>${READ_TOOLS.map((t) => `<li><code>${t}</code></li>`).join("")}</ul>
<p>Add it to an MCP client as a Streamable HTTP server at this URL. In Claude Code:</p>
<pre>claude mcp add --transport http <span class="nw">hushd-read</span> <span class="nw">${u}</span></pre>
<p>To pay, trade and prove for an agent, run the Hushd MCP server next to it with its own seed and spending limits. <a href="/docs/agents">Agents and MCP</a> shows how.</p>
</main>
</body>
</html>`;
}

/** An MCP client's GET (it accepts an event stream) goes to the transport; anything else gets the note. */
async function get(req: Request): Promise<Response> {
  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream")) return handle(req);
  const url = new URL("/mcp", req.url).toString();
  if (accept.includes("text/html")) return new Response(page(url), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  return Response.json(
    {
      name: "hushd",
      about: "Hushd's hosted MCP server: Streamable HTTP, stateless, no keys, read tools only. POST JSON-RPC to this URL from an MCP client.",
      network: NETWORK.id,
      url,
      tools: READ_TOOLS,
      connect: `claude mcp add --transport http hushd-read ${url}`,
      docs: new URL("/docs/agents", req.url).toString(),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export { handle as DELETE, get as GET, handle as POST };
