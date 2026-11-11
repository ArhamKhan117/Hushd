/** Keys, addresses, sealed boxes and a real joinsplit proof made by the SDK. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import * as snarkjs from "snarkjs";
import { openJson, sealJson } from "../src/box.ts";
import { closeHedgeMessage, closeHedgeSignature, DeskApi, ownerKeyFor, roomKeyFor } from "../src/desk.ts";
import { extHash } from "../src/field.ts";
import { decodeAddress, identityFromSeed, isAddress } from "../src/keys.ts";
import { allEndpoints, forBrowser, MAINNET, sendEndpoints, TESTNET, withOverrides } from "../src/network.ts";
import { makeNote, own } from "../src/note.ts";
import { keepRpcErrorBodies, rateLimitPauseMs, readLimit, restEndpoint, rpcOrder, view } from "../src/rpc.ts";
import { loadPoseidon } from "../src/poseidon.ts";
import { proveJoinsplit, type ArtifactSource } from "../src/prove.ts";
import { MerkleTree } from "../src/tree.ts";

const circuits = join(import.meta.dirname, "../../../app/public/circuits");
const src: ArtifactSource = { wasm: (n) => join(circuits, `${n}.wasm`), zkey: (n) => join(circuits, `${n}.zkey`) };

before(loadPoseidon);
// snarkjs keeps its curve worker threads alive; end them so the run can finish.
after(async () => {
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } }).curve_bn128?.terminate();
});

test("an identity is stable for a seed and its address round-trips", () => {
  const a = identityFromSeed(new Uint8Array(32).fill(1));
  const b = identityFromSeed(new Uint8Array(32).fill(1));
  assert.equal(a.address, b.address);
  assert.ok(a.address.startsWith("hushd1"));
  const back = decodeAddress(a.address);
  assert.equal(back.pk, a.pk);
  assert.deepEqual(back.encPublic, a.encPublic);
  assert.ok(!isAddress("hushd1qqqq"));
  assert.notEqual(identityFromSeed(new Uint8Array(32).fill(2)).address, a.address);
});

test("a hedge close is signed for one desk and one deal", () => {
  const id = identityFromSeed(new Uint8Array(32).fill(4));
  const owner = base58.decode(ownerKeyFor(id, 77n).publicKey.slice("ed25519:".length));
  const sig = closeHedgeSignature(id, 77n, 12);
  assert.equal(closeHedgeMessage(TESTNET, 12), "hushd.close:desk.hushd.testnet:12");
  assert.ok(ed25519.verify(sig, new TextEncoder().encode("hushd.close:desk.hushd.testnet:12"), owner));
  const other = withOverrides(TESTNET, { desk: "desk.sandbox" });
  assert.ok(!ed25519.verify(sig, new TextEncoder().encode(closeHedgeMessage(other, 12)), owner));
  assert.ok(ed25519.verify(closeHedgeSignature(id, 77n, 12, other), new TextEncoder().encode("hushd.close:desk.sandbox:12"), owner));
});

test("a trader's deal room key names one deal, and nothing in the room names its address", async () => {
  const id = identityFromSeed(new Uint8Array(32).fill(4));
  const room = roomKeyFor(id, 77n);
  const hexOf = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
  // the same seed and blinding find it again; another deal, or another trader, has another
  assert.deepEqual(roomKeyFor(id, 77n), room);
  assert.notDeepEqual(roomKeyFor(id, 78n).encPublic, room.encPublic);
  assert.notDeepEqual(roomKeyFor(identityFromSeed(new Uint8Array(32).fill(5)), 77n).encPublic, room.encPublic);
  assert.notDeepEqual(room.encPublic, id.encPublic);
  assert.notDeepEqual(room.encSecret, ownerKeyFor(id, 77n).secret);
  // through the API: the maker's answer is filed under the room key, and only it opens it
  const stored: { to: string; box: string }[] = [];
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (init?.method === "POST") {
      stored.push(JSON.parse(String(init.body)) as { to: string; box: string });
      return Response.json({ id: stored.length });
    }
    const to = new URL(url).searchParams.get("to");
    return Response.json(stored.flatMap((m, i) => (m.to === to ? [{ id: i + 1, box: m.box }] : [])));
  }) as typeof fetch;
  try {
    const api = new DeskApi("https://api.example.test");
    await api.send(9, room.encPublic, { t: "plan", outputs: ["1", "2"] });
    assert.deepEqual((await api.inbox(9, room)).map((m) => m.msg), [{ t: "plan", outputs: ["1", "2"] }]);
    assert.equal(stored[0]!.to, hexOf(room.encPublic));
    const wire = JSON.stringify(stored) + asked.join(" ");
    assert.ok(!wire.includes(hexOf(id.encPublic).slice(2)) && !wire.includes(id.address));
    // the key in the address finds nothing there
    assert.deepEqual(await api.inbox(9, id), []);
  } finally {
    globalThis.fetch = real;
  }
});

test("a sealed box opens only for its recipient", () => {
  const alice = identityFromSeed(new Uint8Array(32).fill(3));
  const bob = identityFromSeed(new Uint8Array(32).fill(4));
  const box = sealJson(alice.encPublic, { amount: "5" });
  assert.deepEqual(openJson(alice.encSecret, box), { amount: "5" });
  assert.equal(openJson(bob.encSecret, box), null);
  box[60] ^= 1;
  assert.equal(openJson(alice.encSecret, box), null);
});

test("the SDK proves a private send the circuit's key accepts", async () => {
  const me = identityFromSeed(new Uint8Array(32).fill(5));
  const bob = identityFromSeed(new Uint8Array(32).fill(6));
  const token = "usdc.sandbox";
  const mine = own(makeNote(me.pk, token, 100n), me);
  const tree = new MerkleTree([123n, mine.commitment]);
  const out = await proveJoinsplit(src, me, tree, {
    inputs: [{ ...mine, leafIndex: 1 }],
    outputs: [makeNote(bob.pk, token, 70n), makeNote(me.pk, token, 30n)],
    ext: {},
  });
  const vkey = JSON.parse(readFileSync(join(circuits, "joinsplit.vkey.json"), "utf8"));
  assert.ok(await snarkjs.groth16.verify(vkey, out.publicSignals, out.proof));
  assert.equal(out.publicSignals[0], tree.root().toString());
  assert.equal(out.publicSignals[7], extHash().toString());
});

test("an unbalanced plan is refused before proving", async () => {
  const me = identityFromSeed(new Uint8Array(32).fill(5));
  const mine = own(makeNote(me.pk, "usdc.sandbox", 10n), me);
  await assert.rejects(
    proveJoinsplit(src, me, new MerkleTree([mine.commitment]), { inputs: [mine], outputs: [makeNote(me.pk, "usdc.sandbox", 11n), makeNote(me.pk, "usdc.sandbox", 0n)] }),
    /do not balance/,
  );
});

test("intake encryption round-trips through the model's key", async () => {
  const { encryptForModel, decryptFromModel, clientKey } = await import("../src/intake.ts");
  const { ed25519 } = await import("@noble/curves/ed25519.js");
  // stand in for the model: its ed25519 key, used the way the TEE uses it
  const model = clientKey();
  const wire = encryptForModel("sell 50K NEAR for BTC", model.publicHex);
  assert.equal(decryptFromModel(wire, model.x25519Secret), "sell 50K NEAR for BTC");
  assert.ok(ed25519.getPublicKey(model.secret).length === 32);
});

test("a trader refuses a match below its limit, in the wrong token or of the wrong package", async () => {
  const { checkMatchedTerms } = await import("../src/desk.ts");
  const draft = { kind: "spot" as const, sell: { token: "usdc.hushd.testnet", amount: 1_000_000_000n }, buy: { token: "btc.hushd.testnet", minAmount: 1_300_000n } };
  const terms = {
    rfqId: 1,
    maker: "maker-a.hushd.testnet",
    class: "atomic_pool" as const,
    traderGives: { token: "usdc.hushd.testnet", amount: "1000000000" },
    makerGives: { token: "btc.hushd.testnet", amount: "1310000" },
    hedge: null,
    bond: "0",
    expiresAtMs: 0,
  };
  checkMatchedTerms(terms, draft);
  assert.throws(() => checkMatchedTerms({ ...terms, makerGives: { ...terms.makerGives, amount: "1299999" } }, draft), /less than the least/);
  assert.throws(() => checkMatchedTerms({ ...terms, makerGives: { token: "wnear.hushd.testnet", amount: "1310000" } }, draft), /different token/);
  assert.throws(() => checkMatchedTerms({ ...terms, traderGives: { ...terms.traderGives, amount: "1000000001" } }, draft), /other than what you offered/);
  assert.throws(() => checkMatchedTerms({ ...terms, class: "bonded_hedge" }, draft), /different package/);
});

test("the relayer client calls fetch unbound, as browsers require", async () => {
  const { RelayerClient } = await import("../src/relayer.ts");
  const real = globalThis.fetch;
  let self: unknown = "unset";
  // a fetch that, like the browser's, throws when called with any `this` but the global
  globalThis.fetch = function (this: unknown) {
    self = this;
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return Promise.resolve(new Response(JSON.stringify({ account: "relayer.test", network: "testnet", cashOutFeeBps: 0, allow: {}, lanes: 1 })));
  } as typeof fetch;
  try {
    const info = await new RelayerClient("http://relayer.test").info();
    assert.equal(info.account, "relayer.test");
    assert.ok(self === undefined || self === globalThis);
  } finally {
    globalThis.fetch = real;
  }
});

test("an agent starts while the artifact host is unreachable; the first proof says why it cannot load", async () => {
  const { cachedArtifacts } = await import("../src/node.ts");
  const a = await cachedArtifacts({ baseUrl: "http://127.0.0.1:9/circuits", cacheDir: join(import.meta.dirname, "../.cache-test") });
  await assert.rejects(Promise.resolve(a.wasm("funds")), /Could not load the proving artifacts from http:\/\/127\.0\.0\.1:9\/circuits/);
});

test("RPC calls rotate across endpoints and put a resting one last", () => {
  const urls = ["https://a.example", "https://b.example", "https://c.example"];
  const firsts = new Set([0, 1, 2].map(() => rpcOrder(urls)[0]));
  assert.equal(firsts.size, 3);
  restEndpoint("https://b.example", 60_000);
  for (let i = 0; i < 3; i++) {
    const order = rpcOrder(urls);
    assert.equal(order.length, 3);
    assert.equal(order[2], "https://b.example");
  }
  // once its rest is over it takes its turn again
  const later = Date.now() + 61_000;
  assert.equal([0, 1, 2].filter(() => rpcOrder(urls, later)[0] === "https://b.example").length, 1);
  assert.deepEqual(rpcOrder(["https://only.example"]), ["https://only.example"]);
});

test("a proof's context is the one the pool recomputes", async () => {
  const { proofContext } = await import("../src/field.ts");
  // the same vector is pinned in contracts/pool/src/tests.rs (proof_context)
  const c = proofContext({ kind: "receipt", network: "testnet", pool: "pool.hushd.testnet", reader: "judge.testnet", expiresAtMs: 1_796_000_000_000 });
  assert.equal(c.toString(16).padStart(64, "0"), "00d76a7dabc3a22e33a1c23f69ec04078b50fb5bb639ece5f9857081fea473ee");
});

test("a browser reads from endpoints that keep CORS headers, falls back to the rest, and sends where it always did", async () => {
  for (const net of [TESTNET, MAINNET]) {
    const b = forBrowser(net);
    assert.deepEqual(b.rpc, net.browserRpc);
    assert.ok(b.rpcFallback!.length > 0 && b.rpcFallback!.every((u) => [...net.rpc, ...(net.rpcFallback ?? [])].includes(u) && !b.rpc.includes(u)));
    assert.deepEqual(sendEndpoints(b), sendEndpoints(net));
    // a server reads FastNEAR and keeps dRPC for its fallback, so a browser on the same address keeps dRPC's quota
    assert.ok(net.rpc.every((u) => !net.browserRpc!.includes(u)));
    // every endpoint either may call, sends included, keeps its RPC error bodies
    for (const u of [...b.rpc, ...b.rpcFallback!, ...sendEndpoints(b)]) assert.ok(allEndpoints(b).includes(u), u);
  }
  // a local node named in place of the endpoints never falls back to the real network's
  assert.deepEqual(withOverrides(MAINNET, { rpc: ["http://127.0.0.1:3030"] }).rpcFallback, []);
  // the fallback is asked only when every first endpoint fails
  const real = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === "https://first.example") return new Response("{}", { status: 503 });
    const result = { result: [...new TextEncoder().encode('"ok"')], logs: [], block_height: 1, block_hash: "x" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "hushd", result }), { status: 200 });
  }) as typeof fetch;
  try {
    const net = withOverrides(TESTNET, { rpc: ["https://first.example"], rpcFallback: ["https://fallback.example"] });
    assert.equal(await view<string>(net, "pool.hushd.testnet", "anything"), "ok");
    assert.deepEqual([...new Set(asked)], ["https://first.example", "https://fallback.example"]);
  } finally {
    globalThis.fetch = real;
  }
});

test("in a browser, a rate-limited first endpoint is asked once more after a pause before the fallback is", async () => {
  const real = globalThis.fetch;
  const asked: string[] = [];
  const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: "hushd", result: { result: [...new TextEncoder().encode('"ok"')], logs: [] } }), { status: 200 });
  const limited = () => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "0" } });
  let script: Record<string, (n: number) => Response> = {};
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    return script[url]!(asked.filter((u) => u === url).length);
  }) as typeof fetch;
  try {
    // the browser's case: one first endpoint and a fallback; the rate limit lifts in a moment
    script = { "https://limited.example": (n) => (n === 1 ? limited() : ok()), "https://cors-less.example": ok };
    const browser = withOverrides(TESTNET, { rpc: ["https://limited.example"], rpcFallback: ["https://cors-less.example"], retryRateLimited: true });
    assert.equal(await view<string>(browser, "pool.hushd.testnet", "anything"), "ok");
    assert.deepEqual(asked, ["https://limited.example", "https://limited.example"]);
    // it does not lift: the fallback answers after the one retry
    asked.length = 0;
    script = { "https://still-limited.example": limited, "https://later.example": ok };
    const busy = withOverrides(TESTNET, { rpc: ["https://still-limited.example"], rpcFallback: ["https://later.example"], retryRateLimited: true });
    assert.equal(await view<string>(busy, "pool.hushd.testnet", "anything"), "ok");
    assert.deepEqual(asked, ["https://still-limited.example", "https://still-limited.example", "https://later.example"]);
    // with two first endpoints, the second is asked at once, and only it waits for its retry
    asked.length = 0;
    script = { "https://one.example": limited, "https://two.example": limited, "https://last.example": ok };
    const two = withOverrides(TESTNET, { rpc: ["https://one.example", "https://two.example"], rpcFallback: ["https://last.example"], retryRateLimited: true });
    assert.equal(await view<string>(two, "pool.hushd.testnet", "anything"), "ok");
    assert.equal(asked.length, 4);
    assert.deepEqual(new Set(asked.slice(0, 2)), new Set(["https://one.example", "https://two.example"]));
    assert.equal(asked[2], asked[1]);
    assert.equal(asked[3], "https://last.example");
    // without a fallback there is nothing to save a retry for: a 429 moves on at once
    asked.length = 0;
    script = { "https://alone.example": limited };
    await assert.rejects(view(withOverrides(TESTNET, { rpc: ["https://alone.example"], rpcFallback: [], retryRateLimited: true }), "pool.hushd.testnet", "anything"), /answered 429/);
    assert.deepEqual(asked, ["https://alone.example"]);
    // a server goes straight to its fallback, which answers its 429s readably
    asked.length = 0;
    script = { "https://server-first.example": limited, "https://server-fallback.example": ok };
    assert.equal(await view<string>(withOverrides(TESTNET, { rpc: ["https://server-first.example"], rpcFallback: ["https://server-fallback.example"] }), "pool.hushd.testnet", "anything"), "ok");
    assert.deepEqual(asked, ["https://server-first.example", "https://server-fallback.example"]);
    // every endpoint rate-limited at once: a server pauses and goes round again, so a burst does not end a deal
    asked.length = 0;
    script = { "https://busy-a.example": (n) => (n === 1 ? limited() : ok()), "https://busy-b.example": limited };
    assert.equal(await view<string>(withOverrides(TESTNET, { rpc: ["https://busy-a.example"], rpcFallback: ["https://busy-b.example"] }), "pool.hushd.testnet", "anything"), "ok");
    assert.deepEqual(asked, ["https://busy-a.example", "https://busy-b.example", "https://busy-a.example"]);
    // and gives up after its rounds when the limit holds
    asked.length = 0;
    script = { "https://held-a.example": limited, "https://held-b.example": limited };
    await assert.rejects(view(withOverrides(TESTNET, { rpc: ["https://held-a.example"], rpcFallback: ["https://held-b.example"] }), "pool.hushd.testnet", "anything"), /answered 429/);
    assert.equal(asked.length, 6);
    assert.equal(forBrowser(TESTNET).retryRateLimited, true);
    assert.equal(TESTNET.retryRateLimited, undefined);
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(rateLimitPauseMs("0"), 200);
  assert.equal(rateLimitPauseMs("2"), 2_000);
  assert.equal(rateLimitPauseMs("60"), 3_000);
  assert.equal(rateLimitPauseMs(null, 0), 1_000);
  assert.equal(rateLimitPauseMs("Wed, 21 Oct 2026 07:28:00 GMT", 1), 1_500);
});

test("a read limit runs at most that many reads at once, and every one of them", async () => {
  const limit = readLimit(2);
  let now = 0;
  let most = 0;
  const done: number[] = [];
  const reads = [30, 10, 20, 5, 1].map((ms, i) =>
    limit(async () => {
      most = Math.max(most, ++now);
      await new Promise((r) => setTimeout(r, ms));
      now--;
      done.push(i);
      return i;
    }),
  );
  assert.deepEqual(await Promise.all(reads), [0, 1, 2, 3, 4]);
  assert.equal(most, 2);
  assert.equal(done.length, 5);
  // a read that fails frees its slot too
  await assert.rejects(limit(async () => Promise.reject(new Error("no"))), /no/);
  assert.equal(await limit(async () => "after"), "after");
});

test("an RPC's HTTP 400 with a JSON-RPC error reaches near-kit as an answer; other 400s stay", async () => {
  const real = globalThis.fetch;
  const bodies: Record<string, string> = {
    "https://rpc.example": JSON.stringify({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" } } }),
    "https://other.example": "bad request",
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(bodies[String(input)], { status: 400, statusText: "Bad Request" })) as typeof fetch;
  try {
    keepRpcErrorBodies(["https://rpc.example/"]);
    const rpc = await fetch("https://rpc.example", { method: "POST" });
    assert.equal(rpc.status, 200);
    assert.match(await rpc.text(), /INVALID_TRANSACTION/);
    const other = await fetch("https://other.example", { method: "POST" });
    assert.equal(other.status, 400);
  } finally {
    globalThis.fetch = real;
  }
});

test("transactions go only through endpoints that take them; an RPC override sends where it reads", () => {
  assert.ok(sendEndpoints(TESTNET).length >= 1);
  assert.ok(sendEndpoints(TESTNET).every((u) => !u.includes("drpc")));
  assert.deepEqual(sendEndpoints(withOverrides(TESTNET, { rpc: ["http://127.0.0.1:3030"] })), ["http://127.0.0.1:3030"]);
  assert.deepEqual(sendEndpoints(withOverrides(TESTNET, { rpc: ["https://near-testnet.drpc.org", "https://rpc.testnet.fastnear.com"] })), ["https://rpc.testnet.fastnear.com"]);
});

test("the settle message is the same text the desk contract checks", async () => {
  const { settleMessage } = await import("../src/desk.ts");
  // the vector in contracts/desk/src/tests.rs (the_settle_message_names_the_desk_the_deal_and_the_outputs_in_leg_order)
  assert.equal(settleMessage(withOverrides(TESTNET, { desk: "desk.test" }), 7, ["1", "2", "3", "4"]), "hushd.settle.v1:desk.test:7:1,2,3,4");
});

test("a note picked for a leg in flight is held: a second leg picks another, and a released leg frees it", async () => {
  const { PrivateWallet } = await import("../src/wallet.ts");
  const me = identityFromSeed(new Uint8Array(32).fill(7));
  const them = identityFromSeed(new Uint8Array(32).fill(8));
  const wallet = new PrivateWallet(TESTNET, me, { artifacts: src });
  const token = "usdc.hushd.testnet";
  // two notes already in the tree
  for (const leafIndex of [0, 1]) wallet.track({ ...makeNote(me.pk, token, 100n), leafIndex });
  const first = await wallet.planLeg(1n, { token, amount: 60n }, them.address);
  const second = await wallet.planLeg(2n, { token, amount: 60n }, them.address);
  assert.notEqual(first.inputs[0]!.commitment, second.inputs[0]!.commitment, "two legs in flight picked the same note");
  assert.equal(wallet.spendable(token).length, 0);
  wallet.release(first);
  const third = await wallet.planLeg(3n, { token, amount: 60n }, them.address);
  assert.equal(third.inputs[0]!.commitment, first.inputs[0]!.commitment);
});

test("a held note a sync saw spent still counts: the next leg waits for its change instead of refusing", async () => {
  const { PrivateWallet } = await import("../src/wallet.ts");
  const me = identityFromSeed(new Uint8Array(32).fill(7));
  const them = identityFromSeed(new Uint8Array(32).fill(8));
  const saved: { expected?: { blinding: string }[] }[] = [];
  const relayer = { post: async () => ({}) } as never;
  const wallet = new PrivateWallet(TESTNET, me, { artifacts: src, relayer, store: { load: async () => null, save: async (s) => void saved.push(s) } });
  const token = "usdc.hushd.testnet";
  wallet.track({ ...makeNote(me.pk, token, 100n), leafIndex: 0 });
  const first = await wallet.planLeg(1n, { token, amount: 60n }, them.address);
  // the change is on record before the leg leaves this side, in case it settles after this side gives up
  assert.ok(saved.at(-1)?.expected?.some((e) => e.blinding === first.outputs[1].blinding.toString()));
  // another deal's sync sees the first leg's nullifier on chain before the first deal records its settlement
  let syncs = 0;
  wallet.sync = async () => {
    syncs++;
    first.inputs[0]!.spent = true;
    if (syncs < 2) return;
    await wallet.settled(first);
    const change = wallet.pending().find((n) => n.commitment === first.outputs[1].commitment)!;
    change.leafIndex = 1;
  };
  const second = await wallet.planLeg(2n, { token, amount: 30n }, them.address);
  assert.equal(second.inputs[0]!.commitment, first.outputs[1].commitment, "the second leg spends the first leg's change");
});
