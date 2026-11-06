/**
 * Move the three reference makers onto agent policy wallets (OutLayer custody), once.
 *
 *   tsx scripts/makers-to-policy-wallets.ts
 *
 * For each maker: a policy wallet owned by the deployer (scripts/policy-wallet.ts create),
 * test USDC minted to it for its bond (the maker service posts the bond itself on start,
 * through the wallet), the old key-held account deactivated with its unlocked bond withdrawn,
 * its note file kept under the maker's slot name, and .env switched to the wallet. The
 * private inventory belongs to the maker's seed, not its NEAR account, so it carries over.
 * Stop the makers service before running this and start it after.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Near } from "near-kit";
import { sendEndpoints, TESTNET, view } from "@hushd/sdk";

const ROOT = new URL("../..", import.meta.url).pathname;
const ENV = join(ROOT, ".env");
const DATA = join(ROOT, "services", process.env.MAKERS_DATA_DIR ?? "data/makers");
const BOND = 20_000n * 10n ** 6n;
const net = TESTNET;
const usdc = net.bondToken!;
const desk = net.desk!;
const owner = process.env.DEPLOYER_ACCOUNT ?? "hushd.testnet";

const loadEnv = () => {
  for (const k of Object.keys(process.env)) if (/^MAKER_[ABC]_/.test(k)) delete process.env[k];
  process.loadEnvFile(ENV);
};
const client = (account: string, key: string) => new Near({ network: { networkId: "testnet", rpcUrl: sendEndpoints(net)[0]! }, privateKey: key as `ed25519:${string}`, defaultSignerId: account, defaultWaitUntil: "FINAL" });
const ownerKey = JSON.parse(readFileSync(join(homedir(), ".near-credentials/testnet", `${owner}.json`), "utf8")).private_key as string;

/** Set or remove a variable in .env, keeping every other line as it is. */
function setEnv(k: string, v: string | null) {
  const lines = readFileSync(ENV, "utf8").split("\n").filter((l) => !l.startsWith(`${k}=`));
  if (v !== null) lines.splice(lines.length - (lines.at(-1) === "" ? 1 : 0), 0, `${k}=${v}`);
  writeFileSync(ENV, lines.join("\n"));
}

async function main() {
  loadEnv();
  const o = client(owner, ownerKey);
  for (const slot of ["A", "B", "C"] as const) {
    const p = `MAKER_${slot}`;
    const oldAccount = process.env[`${p}_ACCOUNT`];
    const oldKey = process.env[`${p}_PRIVATE_KEY`];
    if (!process.env[`${p}_POLICY_WALLET_KEY`]) {
      execFileSync(process.execPath, ["--import", "tsx", "scripts/policy-wallet.ts", "create", p, "--per-tx", "0.02", "--daily", "0.2", "--fund", "0.5"], { cwd: join(ROOT, "services"), stdio: "inherit" });
      loadEnv();
    }
    const wallet = process.env[`${p}_POLICY_WALLET_ACCOUNT`]!;

    // the bond: minted by the token's owner, posted by the maker itself through its wallet
    const bonded = BigInt((await view<{ bond: string } | null>(net, desk, "maker", { account_id: wallet }))?.bond ?? "0");
    const held = BigInt(await view<string>(net, usdc, "ft_balance_of", { account_id: wallet }).catch(() => "0"));
    if (bonded + held < BOND) {
      await o.transaction(owner).functionCall(usdc, "mint", { account_id: wallet, amount: (BOND - bonded - held).toString() }, { gas: "30 Tgas" }).send();
      console.log(`${p}: minted ${(BOND - bonded - held) / 10n ** 6n} USDC to ${wallet} for its bond`);
    }

    // retire the key-held account: no new asks reach it, and its unlocked bond comes home
    if (oldAccount && oldKey && oldAccount !== wallet) {
      const m = await view<{ bond: string; locked: string; active: boolean } | null>(net, desk, "maker", { account_id: oldAccount });
      const c = client(oldAccount, oldKey);
      if (m?.active) await c.transaction(oldAccount).functionCall(desk, "set_maker_active", { active: false }, { gas: "30 Tgas", attachedDeposit: 1n }).send();
      const free = m ? BigInt(m.bond) - BigInt(m.locked) : 0n;
      if (free > 0n) await c.transaction(oldAccount).functionCall(desk, "withdraw_bond", { amount: free.toString() }, { gas: "100 Tgas", attachedDeposit: 1n }).send();
      console.log(`${p}: ${oldAccount} deactivated, ${free / 10n ** 6n} USDC of bond withdrawn`);
      const from = join(DATA, `${oldAccount}.notes.enc`);
      const to = join(DATA, `maker-${slot.toLowerCase()}.notes.enc`);
      if (existsSync(from) && !existsSync(to)) copyFileSync(from, to);
      setEnv(`${p}_LEGACY_ACCOUNT`, oldAccount);
      setEnv(`${p}_PRIVATE_KEY`, null);
    }
    setEnv(`${p}_ACCOUNT`, wallet);
    console.log(`${p}: now acts through policy wallet ${wallet}`);
  }
  // the top-up service keeps the new accounts in gas
  loadEnv();
  const targets = (process.env.TOPUP_TARGETS ?? "").split(",").filter((t) => t && !/^maker-[abc]\./.test(t));
  for (const slot of ["A", "B", "C"]) targets.push(`${process.env[`MAKER_${slot}_ACCOUNT`]}:0.3`);
  setEnv("TOPUP_TARGETS", targets.join(","));
  const services = (process.env.SERVICE_ACCOUNTS ?? "").split(",").filter((t) => t && !/^maker-[abc]\./.test(t));
  setEnv("SERVICE_ACCOUNTS", [...services, ...["A", "B", "C"].map((s) => process.env[`MAKER_${s}_ACCOUNT`]!)].join(","));
  console.log("done: restart the makers service; each maker registers and bonds through its wallet");
}

main().catch((e) => {
  console.error("makers-to-policy-wallets:", (e as Error).message);
  process.exit(1);
});
