/** Service logic that needs no network: parsing, pricing, signatures and the deal rooms. */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { encode } from "@msgpack/msgpack";
import { TESTNET } from "@hushd/sdk";
import { decodeSignedDelegateAction, encodeSignedDelegateAction } from "near-kit";
import { buildApi } from "../src/api.js";
import { Db } from "../src/db.js";
import { approveAgentDigest, evmAddress, signDigest } from "../src/hyperliquid.js";
import { eventsInBlock } from "../src/indexer.js";
import { orderAction, toRsv } from "../src/keeper.js";
import { bondFor, priceAsk, spreadBps } from "../src/makers.js";
import { checkDelegate } from "../src/relayer.js";
import { capByMarket, wirePrice, wireSize } from "../src/market.js";
import { parseTargets } from "../src/topup.js";

describe("indexer", () => {
  const block = (status: Record<string, unknown>, receiver: string, logs: string[]) => ({
    block: { header: { height: 7, timestamp_nanosec: "1800000000000000000" } },
    shards: [{ receipt_execution_outcomes: [{ tx_hash: "tx1", receipt: { receipt_id: "r1", receiver_id: receiver }, execution_outcome: { outcome: { logs, status } } }] }],
  });
  const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: "hushd", version: "1.0.0", event, data: [{ deal_id: "3" }] })}`;

  test("keeps our events from successful receipts of watched contracts", () => {
    const out = eventsInBlock(block({ SuccessValue: "" }, "desk.hushd.testnet", [ev("deal_matched"), "plain log"]), new Set(["desk.hushd.testnet"]));
    assert.equal(out.length, 1);
    assert.deepEqual([out[0]!.event, out[0]!.contract, out[0]!.blockMs, out[0]!.logIndex, out[0]!.txHash], ["deal_matched", "desk.hushd.testnet", 1_800_000_000_000, 0, "tx1"]);
  });
  test("ignores failed receipts and other contracts", () => {
    assert.equal(eventsInBlock(block({ Failure: {} }, "desk.hushd.testnet", [ev("x")]), new Set(["desk.hushd.testnet"])).length, 0);
    assert.equal(eventsInBlock(block({ SuccessValue: "" }, "other.testnet", [ev("x")]), new Set(["desk.hushd.testnet"])).length, 0);
  });
});

describe("keeper", () => {
  test("MPC signatures become Hyperliquid r, s, v", () => {
    const rsv = toRsv({ big_r: { affine_point: `02${"ab".repeat(32)}` }, s: { scalar: "cd".repeat(32) }, recovery_id: 1 });
    assert.deepEqual(rsv, { r: `0x${"ab".repeat(32)}`, s: `0x${"cd".repeat(32)}`, v: 28 });
  });
  test("the order sent is the order the desk hashed", () => {
    // contracts/desk/src/hedge.rs pins this msgpack for asset 4, buy, 1100, 0.2, IOC.
    const action = orderAction({ asset: 4, coin: "X", is_buy: true, size: "0.2", limit_px: "1100", deadline_ms: 0, testnet: true }, false);
    assert.equal(Buffer.from(encode(action)).toString("hex"), "83a474797065a56f72646572a66f72646572739186a16104a162c3a170a431313030a173a3302e32a172c2a17481a56c696d697481a3746966a3496f63a867726f7570696e67a26e61");
  });
});

describe("relayer meta transactions", () => {
  const allow = { "desk.hushd.testnet": ["set_maker_active", "withdraw_bond"] };
  // a real NEP-366 payload, encoded and decoded the way a maker's wallet and the relayer do
  const delegate = (receiverId: string, methodName: string, deposit: bigint) =>
    decodeSignedDelegateAction(
      encodeSignedDelegateAction({
        signedDelegate: {
          delegateAction: {
            senderId: "maker-a.hushd.testnet",
            receiverId,
            actions: [{ functionCall: { methodName, args: new TextEncoder().encode("{}"), gas: 30_000_000_000_000n, deposit } }],
            nonce: 1n,
            maxBlockHeight: 100n,
            publicKey: { ed25519Key: { data: Array(32).fill(1) } },
          },
          signature: { ed25519Signature: { data: Array(64).fill(2) } },
        },
      } as never),
    );
  test("relays allowlisted calls with the 1 yoctoNEAR the desk asks for", () => {
    checkDelegate(allow, delegate("desk.hushd.testnet", "withdraw_bond", 1n) as never);
  });
  test("refuses a missing yocto, other methods and other contracts", () => {
    assert.throws(() => checkDelegate(allow, delegate("desk.hushd.testnet", "withdraw_bond", 0n) as never), /exactly 1 yoctoNEAR/);
    assert.throws(() => checkDelegate(allow, delegate("desk.hushd.testnet", "propose_config", 1n) as never), /allowlisted/);
    assert.throws(() => checkDelegate(allow, delegate("pool.hushd.testnet", "withdraw_bond", 1n) as never), /does not send/);
    assert.throws(() => checkDelegate(allow, {}), /signed delegate/);
  });
});

describe("hyperliquid agent approval", () => {
  // vectors from eth_account (encode_typed_data, sign_message) and eth_keys
  test("approveAgent digest and signature match eth_account", () => {
    const d = approveAgentDigest({ agentAddress: `0x${"ab".repeat(20)}`, agentName: "", nonce: 1_700_000_000_000, testnet: true });
    assert.equal(Buffer.from(d).toString("hex"), "b5ee06e24dac21716eb817fcb1b159c8e340fbcfc0eb5a555cc14f831163148c");
    assert.deepEqual(signDigest(`0x${"11".repeat(32)}`, d), {
      r: "0x263733c068009f98897ba61c68465c659264ae6d65e0e916224238122de36e3e",
      s: "0x2343d6f31fc14f2c67e4036041cd7cd464ba9850a6645ff149837f565a35ab5e",
      v: 27,
    });
  });
  test("an MPC public key becomes the deal's Hyperliquid address", () => {
    const pub = Buffer.from("466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f276728176c3c6431f8eeda4538dc37c865e2784f3a9e77d044f33e407797e1278a", "hex");
    assert.equal(evmAddress(pub), "0x1563915e194d8cfba1943570603f7606a3115508");
  });
});

describe("makers", () => {
  test("spreads by style", () => {
    assert.equal(spreadBps("fixed", { volBps: 999, inventoryRatio: 0 }), 25);
    assert.equal(spreadBps("volatility", { volBps: 100, inventoryRatio: 1 }), 70);
    assert.equal(spreadBps("volatility", { volBps: 0, inventoryRatio: 1 }), 15);
    assert.equal(spreadBps("inventory", { volBps: 0, inventoryRatio: 1 }), 15);
    assert.equal(spreadBps("inventory", { volBps: 0, inventoryRatio: 0 }), 75);
  });
  test("bonds come in steps of whole USDC and respect the desk's minimum", () => {
    const usdc = (n: number) => BigInt(n) * 1_000_000n;
    assert.equal(bondFor(500, 6, usdc(1_000)), usdc(1_000));
    assert.equal(bondFor(12_000, 6, usdc(1_000)), usdc(2_000));
    assert.equal(bondFor(30_000, 6, usdc(1_000)), usdc(5_000));
    assert.equal(bondFor(2_500_000, 6, usdc(1_000)), usdc(300_000));
    assert.equal(bondFor(500, 6, usdc(3_000)), usdc(3_000));
  });
  test("pricing rounds in the maker's favour", () => {
    // 1,000 USDC for BTC at 60,000 with 25 bps: 0.01662499... BTC, floored to 8 decimals
    const give = priceAsk({ sellAmount: 1_000_000_000n, sellDecimals: 6, sellUsd: 1, buyDecimals: 8, buyUsd: 60_000, spreadBps: 25 });
    assert.equal(give, 1_662_500n);
  });
  test("a quote never beats the NEAR Intents price less the spread", () => {
    assert.equal(capByMarket(1_700_000n, 1_662_500n, 25), 1_658_343n);
    assert.equal(capByMarket(1_600_000n, 1_662_500n, 25), 1_600_000n);
    assert.equal(capByMarket(1_600_000n, null, 25), 1_600_000n);
  });
  test("Hyperliquid wire numbers", () => {
    assert.equal(wireSize(0.016625, 5), "0.01662");
    assert.equal(wirePrice(59_400.123, 5), "59400");
    assert.equal(wirePrice(2.123456, 1), "2.1235");
  });
});

test("top-up targets", () => {
  assert.deepEqual(parseTargets("a.testnet:5, b.testnet:0.5"), [
    { account: "a.testnet", floor: 5n * 10n ** 24n },
    { account: "b.testnet", floor: 5n * 10n ** 23n },
  ]);
  assert.throws(() => parseTargets("a.testnet"));
});

describe("deal rooms (Postgres)", () => {
  const db = new Db(process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/hushd_test");
  const api = buildApi(TESTNET, db, () => 1_000);
  const to = `0x${"11".repeat(32)}`;
  let pg = true;
  before(async () => {
    try {
      await db.migrate();
      await db.q("delete from messages");
    } catch {
      pg = false;
    }
  });
  after(() => db.close());

  test("only the named recipient's messages come back, in order", async (t) => {
    if (!pg) return t.skip("no Postgres at TEST_DATABASE_URL");
    for (const [r, box] of [[to, "QUJD"], [`0x${"22".repeat(32)}`, "REVG"], [to, "R0hJ"]] as const) {
      const res = await api.request(`/v1/deals/4/messages`, { method: "POST", body: JSON.stringify({ to: r, box }), headers: { "content-type": "application/json" } });
      assert.equal(res.status, 200);
    }
    const list = (await (await api.request(`/v1/deals/4/messages?to=${to}`)).json()) as { id: number; box: string }[];
    assert.deepEqual(list.map((m) => m.box), ["QUJD", "R0hJ"]);
    const after1 = (await (await api.request(`/v1/deals/4/messages?to=${to}&after=${list[0]!.id}`)).json()) as unknown[];
    assert.equal(after1.length, 1);
  });

  test("malformed messages are refused", async (t) => {
    if (!pg) return t.skip("no Postgres at TEST_DATABASE_URL");
    const bad = await api.request(`/v1/deals/4/messages`, { method: "POST", body: JSON.stringify({ to: "nope", box: "QUJD" }), headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 400);
  });
});

test("a service records the events of its own transaction", async () => {
  const { eventsInOutcome } = await import("../src/indexer.js");
  const ev = (event: string) => `EVENT_JSON:${JSON.stringify({ standard: "hushd", version: "1.0.0", event, data: [{ deal_id: "0" }] })}`;
  const outcome = {
    transaction: { hash: "tx9" },
    receipts_outcome: [
      { id: "r1", block_hash: "b", outcome: { executor_id: "desk.hushd.testnet", logs: [ev("deal_matched")], status: { SuccessValue: "" } } },
      { id: "r2", block_hash: "b", outcome: { executor_id: "other.testnet", logs: [ev("deal_matched")], status: { SuccessValue: "" } } },
      { id: "r3", block_hash: "b", outcome: { executor_id: "desk.hushd.testnet", logs: [ev("receipt")], status: { Failure: {} } } },
    ],
  };
  const out = eventsInOutcome(outcome, new Set(["desk.hushd.testnet"]), { height: 5, ms: 7 });
  assert.deepEqual(out.map((e) => [e.event, e.receiptId, e.txHash, e.blockHeight]), [["deal_matched", "r1", "tx9", 5]]);
});
