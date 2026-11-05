/**
 * The hosted Hushd MCP server (Streamable HTTP, stateless): read tools only. It holds
 * no keys; an agent that pays or trades runs `npx @hushd/mcp` with its own seed.
 */
import { createServer } from "@hushd/mcp";
import type { ProofKind } from "@hushd/sdk";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NETWORK } from "@/lib/hushd/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const vkeys = new Map<string, unknown>();

async function handle(req: Request): Promise<Response> {
  const vkey = async (kind: ProofKind) => {
    if (!vkeys.has(kind)) vkeys.set(kind, await (await fetch(new URL(`/circuits/${kind}.vkey.json`, req.url))).json());
    return vkeys.get(kind);
  };
  const server = createServer({ net: NETWORK, vkey });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export { handle as DELETE, handle as GET, handle as POST };
