/**
 * The owner's side of an agent policy wallet (OutLayer custody on NEAR testnet).
 *
 *   tsx scripts/policy-wallet.ts create <ENV_PREFIX> [--owner hushd.testnet] [--per-tx 0.02] [--daily 0.2] [--per-hour 60] [--fund 0.3]
 *   tsx scripts/policy-wallet.ts show <ENV_PREFIX>
 *   tsx scripts/policy-wallet.ts freeze|unfreeze <ENV_PREFIX> [--owner hushd.testnet]
 *
 * `create` registers a wallet, has it encrypt and sign the policy for the owner, stores the
 * policy on chain from the owner's account (which makes the owner its only controller),
 * funds the wallet's implicit account for gas, and only then writes the wallet's key to
 * .env as <ENV_PREFIX>_POLICY_WALLET_KEY for the agent. The public parts (account, owner,
 * rules, transactions) go to deployments/testnet.json under `policyWallets`.
 * The owner's key is read from ~/.near-credentials/testnet/<owner>.json.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";
import { CUSTODY, type CallSpec, CustodyWallet, TESTNET, custodyPubkey, custodyView, freezeCall, hushdPolicyRules, sendEndpoints, storePolicyCall, unfreezeCall } from "@hushd/sdk";

const ROOT = new URL("../..", import.meta.url).pathname;
const ENV = join(ROOT, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);
const DEPLOYMENT = join(ROOT, "deployments/testnet.json");
const net = TESTNET;
const custody = CUSTODY.testnet;

const [cmd, prefix] = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1]! : fallback;
};
const nearToYocto = (s: string) => BigInt(Math.round(Number(s) * 1e6)) * 10n ** 18n;

function ownerClient(owner: string): Near {
  const key = JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${owner}.json`), "utf8")).private_key as `ed25519:${string}`;
  return new Near({ network: { networkId: "testnet", rpcUrl: sendEndpoints(net)[0]! }, privateKey: key, defaultSignerId: owner, defaultWaitUntil: "FINAL" });
}

async function send(client: Near, from: string, c: CallSpec): Promise<string> {
  const r = await client.transaction(from).functionCall(c.receiver, c.method, c.args, { gas: `${Number(c.gas)}`, attachedDeposit: c.deposit }).send();
  if ((r.status as { Failure?: unknown }).Failure) throw new Error(`${c.receiver}.${c.method} failed: ${JSON.stringify((r.status as { Failure?: unknown }).Failure)}`);
  return r.transaction.hash;
}

type Record_ = { prefix: string; account: string; owner: string; rules: unknown; txs: Record<string, string>; createdAt: string };
function recordWallet(r: Partial<Record_> & { prefix: string }) {
  const d = JSON.parse(readFileSync(DEPLOYMENT, "utf8")) as { policyWallets?: Record<string, Record_> };
  d.policyWallets ??= {};
  const prev = d.policyWallets[r.prefix];
  d.policyWallets[r.prefix] = { ...(prev ?? {}), ...r, txs: { ...(prev?.txs ?? {}), ...(r.txs ?? {}) } } as Record_;
  writeFileSync(DEPLOYMENT, `${JSON.stringify(d, null, 2)}\n`);
}

async function main() {
  if (!cmd || !prefix || !/^[A-Z][A-Z0-9_]*$/.test(prefix)) throw new Error("usage: policy-wallet.ts create|show|freeze|unfreeze <ENV_PREFIX>");
  const keyVar = `${prefix}_POLICY_WALLET_KEY`;
  const owner = flag("owner", process.env.DEPLOYER_ACCOUNT ?? "hushd.testnet");

  if (cmd === "create") {
    if (process.env[keyVar]) throw new Error(`${keyVar} is already set: this agent has a policy wallet`);
    const rules = hushdPolicyRules(net, { perTxYocto: nearToYocto(flag("per-tx", "0.02")), dailyYocto: nearToYocto(flag("daily", "0.2")), maxPerHour: Number(flag("per-hour", "60")) });
    const { wallet, walletId, accountId } = await CustodyWallet.register(custody.api);
    const encrypted = await wallet.encryptPolicy(walletId, rules);
    const signed = await wallet.signPolicy(encrypted, owner);
    const pubkey = `ed25519:${signed.publicKeyHex}`;
    const client = ownerClient(owner);
    const cost = await custodyView.cost(net, pubkey, encrypted);
    // the owner stores the policy before the agent ever holds the key: the first to store it controls it
    const stored = await send(client, owner, storePolicyCall(custody.contract, signed.publicKeyHex, encrypted, signed.signatureHex, cost + 10n ** 21n));
    await wallet.refresh(walletId);
    const funded = (await client.transaction(owner).transfer(accountId, `${flag("fund", "0.3")} NEAR` as `${number} NEAR`).send()).transaction.hash;
    const p = await wallet.policy();
    if (p.policy !== "stored" || !p.rules) throw new Error("the wallet does not report the stored policy yet");
    appendFileSync(ENV, `${keyVar}=${wallet.apiKey}\n${prefix}_POLICY_WALLET_ACCOUNT=${accountId}\n`);
    recordWallet({ prefix, account: accountId, owner, rules, txs: { store_policy: stored, fund: funded }, createdAt: new Date().toISOString() });
    console.log(`${prefix}: policy wallet ${accountId}, controlled by ${owner}`);
    console.log(`  policy stored ${net.explorer}/txns/${stored}`);
    console.log(`  funded        ${net.explorer}/txns/${funded}`);
    console.log(`  the agent's key is in .env as ${keyVar}`);
    return;
  }

  const key = process.env[keyVar];
  if (!key) throw new Error(`${keyVar} is not in .env`);
  const wallet = new CustodyWallet(key, custody.api);
  const a = await wallet.address();
  if (cmd === "show") {
    console.log(JSON.stringify({ account: a.accountId, chain: await custodyView.policy(net, a.publicKey), wallet: await wallet.policy() }, null, 2));
    return;
  }
  if (cmd === "freeze" || cmd === "unfreeze") {
    const tx = await send(ownerClient(owner), owner, (cmd === "freeze" ? freezeCall : unfreezeCall)(custody.contract, custodyPubkey(a.accountId)));
    recordWallet({ prefix, txs: { [`${cmd}_${Date.now()}`]: tx } });
    console.log(`${prefix}: ${cmd === "freeze" ? "frozen" : "unfrozen"} by ${owner} ${net.explorer}/txns/${tx}`);
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => {
  console.error("policy-wallet:", (e as Error).message);
  process.exit(1);
});
