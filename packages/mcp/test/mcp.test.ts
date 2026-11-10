/** The MCP server's surface and its spending limits, with no network. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { encodeLink, identityFromSeed, linkUrl, newLink, TESTNET } from "@hushd/sdk";
import { createAgent, createServer, Limits, parseCaps } from "../src/index.ts";
import { parseRules } from "../src/limits.ts";

const circuits = join(import.meta.dirname, "../../../app/public/circuits");

async function connect(withAgent: boolean, home = mkdtempSync(join(tmpdir(), "hushd-mcp-")), extra: Record<string, string> = {}) {
  const env = { HUSHD_HOME: home, HUSHD_CIRCUITS_DIR: circuits, HUSHD_LIMIT_PER_PAYMENT: "USDC=10", HUSHD_LIMIT_PER_DAY: "USDC=15", ...extra };
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
  for (const n of ["hushd_address", "hushd_send", "hushd_trade", "hushd_prove", "hushd_pay_x402", "hushd_limits", "hushd_pay_link", "hushd_claim_link", "hushd_my_links", "hushd_take_back_link"]) assert.ok(names.includes(n), n);
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

test("the owner's expiry and payee list refuse before anything is proved", () => {
  const dir = mkdtempSync(join(tmpdir(), "hushd-rules-"));
  let now = new Date("2026-11-30T23:59:00Z");
  const rules = parseRules({ HUSHD_LIMITS_EXPIRE: "2026-12-01T00:00:00Z", HUSHD_ALLOW_TO: "hushd1friend, bob.testnet" });
  const l = new Limits(TESTNET, parseCaps(TESTNET, "USDC=10"), parseCaps(TESTNET, "USDC=15"), join(dir, "spent.json"), () => now, rules);
  l.check("usdc.hushd.testnet", 1_000_000n, "bob.testnet");
  l.check("usdc.hushd.testnet", 1_000_000n);
  assert.throws(() => l.check("usdc.hushd.testnet", 1_000_000n, "mallory.testnet"), /not on this agent's list of payees/);
  now = new Date("2026-12-01T00:00:00Z");
  assert.throws(() => l.check("usdc.hushd.testnet", 1_000_000n, "bob.testnet"), /expired on 2026-12-01/);
  assert.deepEqual(l.describe().payees, ["hushd1friend", "bob.testnet"]);
  assert.throws(() => parseRules({ HUSHD_LIMITS_EXPIRE: "soon" }), /Bad HUSHD_LIMITS_EXPIRE/);
});

test("without a NEAR account the policy tool says so, and spending tools name both ways to add one", async () => {
  const c = await connect(true);
  const p = await c.callTool({ name: "hushd_policy", arguments: {} });
  assert.equal(JSON.parse((p.content as { text: string }[])[0]!.text).near_account, null);
  const s = await c.callTool({ name: "hushd_shield", arguments: { token: "USDC", amount: "1" } });
  assert.match((s.content as { text: string }[])[0]!.text, /HUSHD_POLICY_WALLET_KEY/);
  await c.close();
});

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0]!.text;

test("paying as a link counts against the same limits as a private send, before anything is proved", async () => {
  const home = mkdtempSync(join(tmpdir(), "hushd-mcp-"));
  // 8 USDC already spent today, in the ledger every spending tool shares
  const tag = identityFromSeed(new Uint8Array(32).fill(3)).address.slice(-12);
  writeFileSync(join(home, `testnet-${tag}.spent.json`), JSON.stringify({ day: new Date().toISOString().slice(0, 10), spent: { "usdc.hushd.testnet": "8000000" } }));
  const c = await connect(true, home);
  const over = await c.callTool({ name: "hushd_pay_link", arguments: { token: "USDC", amount: "11" } });
  assert.equal(over.isError, true);
  assert.match(text(over), /over the limit of 10 per payment/);
  assert.match(text(await c.callTool({ name: "hushd_pay_link", arguments: { token: "USDC", amount: "8" } })), /over the daily limit of 15/);
  assert.match(text(await c.callTool({ name: "hushd_pay_link", arguments: { token: "wNEAR", amount: "1" } })), /No spending limit is set for wNEAR/);
  assert.deepEqual(JSON.parse(text(await c.callTool({ name: "hushd_my_links", arguments: {} }))), []);
  assert.match(text(await c.callTool({ name: "hushd_take_back_link", arguments: { index: 0 } })), /No link #0/);
  await c.close();
});

test("an agent limited to a list of payees may not pay as a link", async () => {
  const c = await connect(true, undefined, { HUSHD_ALLOW_TO: "bob.testnet" });
  const r = await c.callTool({ name: "hushd_pay_link", arguments: { token: "USDC", amount: "1" } });
  assert.equal(r.isError, true);
  assert.match(text(r), /may not pay as a link/);
  await c.close();
});

test("a claim refuses a damaged link and a token the network does not list, before reading the pool", async () => {
  const c = await connect(true);
  const good = linkUrl("https://hushd.net", newLink("usdc.hushd.testnet", 1_000_000n));
  const damaged = await c.callTool({ name: "hushd_claim_link", arguments: { link: good.slice(0, -3) } });
  assert.equal(damaged.isError, true);
  assert.match(text(damaged), /not a complete Hushd claim link/);
  const other = await c.callTool({ name: "hushd_claim_link", arguments: { link: encodeLink(newLink("unknown-token.testnet", 1_000_000n)) } });
  assert.match(text(other), /does not list on NEAR testnet/);
  await c.close();
});

/** A resource that answers 402 asking for `price` USDC base units to `payTo`, and counts its requests. */
async function paywall(payTo: string, price = "1000000") {
  const { createServer: http } = await import("node:http");
  let hits = 0;
  const srv = http((req, res) => {
    hits++;
    const accepts = [{ scheme: "hushd", network: "near-testnet", maxAmountRequired: price, asset: "usdc.hushd.testnet", payTo, resource: `http://${req.headers.host}${req.url}` }];
    res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ x402Version: 1, accepts }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/quote`, hits: () => hits, close: () => new Promise((r) => srv.close(r)) };
}

test("an x402 payment obeys the payee list and the limits' end date, like a private send, before anything is proved", async () => {
  const payee = identityFromSeed(new Uint8Array(32).fill(9)).address;
  const wall = await paywall(payee);
  try {
    // a payee list without the 402's address refuses it
    const listed = await connect(true, undefined, { HUSHD_ALLOW_TO: "bob.testnet" });
    const r = await listed.callTool({ name: "hushd_pay_x402", arguments: { url: wall.url } });
    assert.equal(r.isError, true);
    assert.match(text(r), new RegExp(`${payee} is not on this agent's list of payees`));
    await listed.close();
    // limits that ended refuse it too
    const expired = await connect(true, undefined, { HUSHD_LIMITS_EXPIRE: "2020-01-01" });
    const e = await expired.callTool({ name: "hushd_pay_x402", arguments: { url: wall.url } });
    assert.equal(e.isError, true);
    assert.match(text(e), /limits expired on 2020-01-01/);
    await expired.close();
    // and a price over the cap per payment is refused, not paid
    const capped = await connect(true);
    const wall2 = await paywall(payee, "11000000");
    try {
      const o = await capped.callTool({ name: "hushd_pay_x402", arguments: { url: wall2.url } });
      assert.equal(o.isError, true);
      assert.match(text(o), /above the limit for one payment/);
    } finally {
      await wall2.close();
      await capped.close();
    }
    // each call fetched the resource once and paid nothing
    assert.equal(wall.hits(), 2);
  } finally {
    await wall.close();
  }
});

test("a trade needs a floor above zero, before anything is asked", async () => {
  const c = await connect(true);
  const trade = (await c.listTools()).tools.find((t) => t.name === "hushd_trade")!;
  assert.ok((trade.inputSchema.required ?? []).includes("min_receive"));
  assert.match(String((trade.inputSchema.properties as Record<string, { description?: string }>).min_receive?.description), /^Required: the least you accept/);
  const none = await c.callTool({ name: "hushd_trade", arguments: { sell_token: "USDC", sell_amount: "5", buy_token: "wNEAR" } });
  assert.equal(none.isError, true);
  assert.match(text(none), /min_receive/);
  const zero = await c.callTool({ name: "hushd_trade", arguments: { sell_token: "USDC", sell_amount: "5", buy_token: "wNEAR", min_receive: "0" } });
  assert.equal(zero.isError, true);
  assert.match(text(zero), /Set min_receive above zero/);
  await c.close();
});
