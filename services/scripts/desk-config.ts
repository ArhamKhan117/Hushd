/**
 * The desk's timelocked settings, from the owner's account (its key in ~/.near-credentials):
 *
 *   tsx scripts/desk-config.ts                              # current settings and any pending change
 *   tsx scripts/desk-config.ts propose matcher_project=hushd.testnet/matcher@<wasm hash>
 *   tsx scripts/desk-config.ts apply <id>                   # after config_timelock_ns
 *   tsx scripts/desk-config.ts cancel <id>
 *   tsx scripts/desk-config.ts pin                          # propose pinning the matcher to OutLayer's active build
 *
 * A proposal names the whole new config; fields not given keep their current value.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { keepRpcErrorBodies, sendEndpoints, TESTNET, view } from "@hushd/sdk";
import { Near } from "near-kit";

const ROOT = new URL("../..", import.meta.url).pathname;
const ENV = join(ROOT, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);
const net = TESTNET;
const DESK = net.desk!;
const FIELDS = ["owner", "outlayer", "matcher_project", "secrets_owner", "keeper", "outlayer_fee", "min_bond"] as const;

type Config = Record<(typeof FIELDS)[number] | "config_timelock_ns", string>;

function owner(account: string): Near {
  const file = join(homedir(), ".near-credentials/testnet", `${account}.json`);
  const key = JSON.parse(readFileSync(file, "utf8")) as { private_key: string };
  keepRpcErrorBodies(net);
  return new Near({ network: { networkId: "testnet", rpcUrl: sendEndpoints(net)[0]! }, privateKey: key.private_key as `ed25519:${string}`, defaultSignerId: account, defaultWaitUntil: "FINAL" });
}

async function send(method: string, args: object) {
  const config = await view<Config>(net, DESK, "config");
  const out = (await owner(config.owner).transaction(config.owner).functionCall(DESK, method, args, { gas: "30 Tgas", attachedDeposit: 1n }).send()) as unknown as { transaction?: { hash?: string } };
  console.log(`${method}: ${net.explorer}/txns/${out.transaction?.hash ?? ""}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const config = await view<Config>(net, DESK, "config");
  if (!cmd) {
    console.log(JSON.stringify({ config, pending: await view(net, DESK, "pending_config") }, null, 2));
    return;
  }
  if (cmd === "propose" || cmd === "pin") {
    const change = Object.fromEntries(FIELDS.map((f) => [f, config[f]])) as Record<string, string>;
    if (cmd === "pin") {
      const project = await view<{ active_version: string } | null>(net, config.outlayer, "get_project", { project_id: config.matcher_project.split("@")[0] });
      if (!project) throw new Error(`OutLayer has no project ${config.matcher_project}`);
      change.matcher_project = `${config.matcher_project.split("@")[0]}@${project.active_version}`;
    }
    for (const kv of rest) {
      const [k, v] = kv.split("=");
      if (!FIELDS.includes(k as (typeof FIELDS)[number]) || v === undefined) throw new Error(`unknown setting ${kv}; one of ${FIELDS.join(", ")}`);
      change[k!] = v;
    }
    console.log(`proposing ${JSON.stringify(change)}; it applies after ${Number(BigInt(config.config_timelock_ns) / 3_600_000_000_000n)} h`);
    await send("propose_config", { change });
    return;
  }
  if ((cmd === "apply" || cmd === "cancel") && rest[0]) {
    await send(`${cmd}_config`, { id: rest[0] });
    return;
  }
  throw new Error("usage: desk-config.ts [propose k=v ... | pin | apply <id> | cancel <id>]");
}

main().catch((e) => {
  console.error("desk-config:", (e as Error).message);
  process.exit(1);
});
