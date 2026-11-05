/** The MCP server's surface and its spending limits, with no network. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TESTNET } from "@hushd/sdk";
import { createAgent, createServer, Limits, parseCaps } from "../src/index.ts";

const circuits = join(import.meta.dirname, "../../../app/public/circuits");

async function connect(withAgent: boolean, home = mkdtempSync(join(tmpdir(), "hushd-mcp-"))) {
  const env = { HUSHD_HOME: home, HUSHD_CIRCUITS_DIR: circuits, HUSHD_LIMIT_PER_PAYMENT: "USDC=10", HUSHD_LIMIT_PER_DAY: "USDC=15" };
  const agent = withAgent ? await createAgent(env, new Uint8Array(32).fill(3)) : undefined;
  const server = createServer({ net: TESTNET, vkey: async () => ({}), ...(agent ? { agent } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("without a seed only read tools are offered", async () => {
  const c = await connect(false);
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["hushd_deal", "hushd_desk_deals", "hushd_makers", "hushd_status", "hushd_verify_proof"]);
  await c.close();
});

test("with a seed the wallet tools appear, and limits refuse before anything is proved", async () => {
  const c = await connect(true);
  const names = (await c.listTools()).tools.map((t) => t.name);
  for (const n of ["hushd_address", "hushd_send", "hushd_trade", "hushd_prove", "hushd_pay_x402", "hushd_limits"]) assert.ok(names.includes(n), n);
  const addr = await c.callTool({ name: "hushd_address", arguments: {} });
  assert.match((addr.content as { text: string }[])[0]!.text, /hushd1/);
  const over = await c.callTool({ name: "hushd_send", arguments: { to: "hushd1qqqq", token: "USDC", amount: "11" } });
  assert.equal(over.isError, true);
  assert.match((over.content as { text: string }[])[0]!.text, /over the limit of 10 per payment/);
  const wnear = await c.callTool({ name: "hushd_send", arguments: { to: "hushd1qqqq", token: "wNEAR", amount: "1" } });
  assert.match((wnear.content as { text: string }[])[0]!.text, /No spending limit is set for wNEAR/);
  await c.close();
});

test("the daily limit holds across a restart and resets the next day", () => {
  const dir = mkdtempSync(join(tmpdir(), "hushd-limits-"));
  let now = new Date("2026-11-06T10:00:00Z");
  const make = () => new Limits(TESTNET, parseCaps(TESTNET, "USDC=10"), parseCaps(TESTNET, "USDC=15"), join(dir, "spent.json"), () => now);
  const l = make();
  l.check("usdc.hushd.testnet", 8_000_000n);
  l.record("usdc.hushd.testnet", 8_000_000n);
  assert.throws(() => make().check("usdc.hushd.testnet", 8_000_000n), /daily limit/);
  assert.equal(make().maxFor("usdc.hushd.testnet"), 7_000_000n);
  now = new Date("2026-11-07T00:00:01Z");
  make().check("usdc.hushd.testnet", 10_000_000n);
});
