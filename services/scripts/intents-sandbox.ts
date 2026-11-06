/**
 * The NEAR Intents direct trade, end to end on a local NEAR node, against the exact
 * verifier code that runs at `intents.near` (read from mainnet with `view_code` and
 * checked against its code hash). Two agents deposit, trade with signed `token_diff`s,
 * withdraw, and a replay of the trade is refused.
 *
 *   pnpm --filter @hushd/services intents:sandbox
 *
 * Needs the token wasm (`cargo near build non-reproducible-wasm` in contracts/token).
 * NEAR_SANDBOX_BIN_PATH points at a near-sandbox binary; without it near-kit downloads one.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { Near } from "near-kit";
import { Sandbox } from "near-kit/sandbox";
import { INTENTS_MAINNET, MAINNET, TESTNET, verifierView, withOverrides } from "@hushd/sdk";
import { IntentsAgent, executeSigned, signTrade } from "../src/intents-trade.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const DATA = join(ROOT, "services/data");

/** The verifier's code as deployed on mainnet, cached locally, checked against the chain's code hash. */
async function mainnetVerifierCode(): Promise<Uint8Array> {
  const path = join(DATA, "intents-verifier.wasm");
  const r = await fetch(MAINNET.rpc[0]!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: existsSync(path) ? "view_account" : "view_code", finality: "final", account_id: INTENTS_MAINNET.verifier } }),
  }).then((x) => x.json() as Promise<{ result: { code_base64?: string; code_hash?: string; hash?: string } }>);
  const code = existsSync(path) ? readFileSync(path) : Buffer.from(r.result.code_base64!, "base64");
  const want = r.result.code_hash ?? r.result.hash;
  const got = base58.encode(createHash("sha256").update(code).digest());
  assert.equal(got, want, "the cached verifier no longer matches intents.near (delete services/data/intents-verifier.wasm)");
  if (!existsSync(path)) {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(path, code);
  }
  return code;
}

const step = (s: string) => console.log(`\n- ${s}`);

async function main() {
  const verifierCode = await mainnetVerifierCode();
  const tokenCode = readFileSync(join(ROOT, "contracts/target/near/hushd_token/hushd_token.wasm"));
  console.log(`verifier code: ${verifierCode.length} bytes, same hash as intents.near on mainnet`);

  const sandbox = await Sandbox.start({ ...(process.env.NEAR_SANDBOX_BIN_PATH ? { binaryPath: process.env.NEAR_SANDBOX_BIN_PATH } : {}), detached: false });
  try {
    const rootId = sandbox.rootAccount.id;
    const root = new Near({ network: sandbox, privateKey: sandbox.rootAccount.secretKey as `ed25519:${string}`, defaultSignerId: rootId, defaultWaitUntil: "FINAL" });
    const net = withOverrides(TESTNET, { rpc: [sandbox.rpcUrl] });
    const usdc = `usdc.${rootId}`;
    const wnear = `wnear.${rootId}`;
    const verifier = `intents.${rootId}`;

    step("deploy two tokens and the verifier");
    for (const [id, symbol, decimals] of [[usdc, "USDC", 6], [wnear, "wNEAR", 24]] as const) {
      await root.transaction(rootId).createAccount(id).transfer(id, "10 NEAR").deployContract(id, tokenCode)
        .functionCall(id, "new", { owner_id: rootId, name: symbol, symbol, decimals, icon: null, faucet_amount: "0", faucet_cooldown_ns: "0" }, { gas: "100 Tgas" }).send();
    }
    await root.transaction(rootId).createAccount(verifier).transfer(verifier, "30 NEAR").deployContract(verifier, verifierCode)
      .functionCall(verifier, "new", { config: { wnear_id: wnear, fees: { fee: 1, fee_collector: verifier }, roles: { super_admins: [rootId], admins: {}, grantees: {} } } }, { gas: "300 Tgas" }).send();
    const [fee, salt] = [await verifierView.fee(net, verifier), await verifierView.salt(net, verifier)];
    console.log(`verifier fee ${fee} pip, salt ${salt}`);

    step("two agents: implicit accounts with their own keys");
    const a = new IntentsAgent(net, verifier, ed25519.utils.randomSecretKey(), "trader");
    const b = new IntentsAgent(net, verifier, ed25519.utils.randomSecretKey(), "maker");
    for (const x of [a, b]) await root.transaction(rootId).transfer(x.accountId, "2 NEAR").send();
    await root.transaction(rootId).functionCall(usdc, "mint", { account_id: a.accountId, amount: "5000000" }, { gas: "30 Tgas" }).send();
    await root.transaction(rootId).functionCall(wnear, "mint", { account_id: b.accountId, amount: (10n ** 24n).toString() }, { gas: "30 Tgas" }).send();
    for (const t of [usdc, wnear]) await root.transaction(rootId).functionCall(t, "storage_deposit", { account_id: verifier, registration_only: true }, { gas: "30 Tgas", attachedDeposit: "0.00125 NEAR" }).send();

    step("deposit into the verifier");
    const give = { token: usdc, amount: 1_000_000n };
    const take = { token: wnear, amount: 400_000_000_000_000_000_000_000n };
    await a.deposit(usdc, give.amount);
    await b.deposit(wnear, take.amount);
    assert.equal((await a.balances([usdc]))[usdc], give.amount);
    assert.equal((await b.balances([wnear]))[wnear], take.amount);

    step("trade: the trader gives 1 USDC for 0.4 wNEAR; both sign, the maker submits");
    const deadline = Date.now() + 5 * 60_000;
    const trade = await signTrade(a, b, give, take, deadline);
    const done = await executeSigned(b, [trade.a, trade.b]);
    console.log(`executed ${done.executed} intents in ${done.txHash}`);
    const [ab, bb] = [await a.balances([usdc, wnear]), await b.balances([usdc, wnear])];
    assert.deepEqual([ab[usdc], ab[wnear]], [0n, BigInt(trade.diffs.a[`nep141:${wnear}`]!)]);
    assert.deepEqual([bb[usdc], bb[wnear]], [BigInt(trade.diffs.b[`nep141:${usdc}`]!), 0n]);
    console.log(`trader holds ${ab[wnear]} yocto wNEAR, maker ${bb[usdc]} USDC units inside the verifier`);

    step("a replay of the same signed trade is refused");
    await assert.rejects(executeSigned(b, [trade.a, trade.b]), /nonce was already used|insufficient balance/);

    step("withdraw both sides back to the agents' own accounts");
    await a.ensureRegistered(wnear);
    // the maker gave all its wNEAR away: register it on USDC directly, not from a balance it no longer has
    await b.ensureRegistered(usdc);
    const out = await executeSigned(a, [await a.withdrawals([{ token: wnear, amount: ab[wnear]! }], a.accountId, deadline), await b.withdrawals([{ token: usdc, amount: bb[usdc]! }], b.accountId, deadline)]);
    console.log(`withdrawn in ${out.txHash}`);
    assert.equal(await a.tokenBalance(wnear), ab[wnear]);
    assert.equal(await b.tokenBalance(usdc), bb[usdc]);
    assert.equal(await a.tokenBalance(usdc), 4_000_000n);
    console.log("\nPASS: deposit, direct trade, replay refused, withdrawals, all on the mainnet verifier code");
  } finally {
    await sandbox.stop();
  }
}

main().catch((e) => {
  console.error("intents-sandbox:", (e as Error).stack ?? e);
  process.exit(1);
});
