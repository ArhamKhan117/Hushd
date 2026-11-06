/**
 * Top-up: keeps every service wallet funded from one treasury account. Each target has
 * a floor; below it, the treasury sends enough to reach twice the floor. The API's
 * /v1/status shows every balance and warns when the treasury itself runs low.
 *
 *   TOPUP_TARGETS="relayer.hushd.testnet:5,keeper.hushd.testnet:2,..."   (floors in NEAR)
 */
import { accountBalance, type HushdNetwork } from "@hushd/sdk";
import { account, network, settings } from "./config.js";
import { Signer } from "./chain.js";
import { app, listen } from "./http.js";

const YOCTO = 10n ** 24n;

export function parseTargets(s: string): { account: string; floor: bigint }[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const [acc, near] = x.split(":");
      if (!acc || !near || !/^\d+(\.\d+)?$/.test(near)) throw new Error(`bad top-up target ${x}`);
      return { account: acc, floor: BigInt(Math.round(Number(near) * 1000)) * (YOCTO / 1000n) };
    });
}

export class TopUp {
  log: { at: number; account: string; amount: string; txHash: string }[] = [];
  constructor(readonly net: HushdNetwork, readonly treasury: Signer, readonly targets: { account: string; floor: bigint }[]) {}

  async step() {
    for (const t of this.targets) {
      const bal = await accountBalance(this.net, t.account);
      if (bal !== null && bal >= t.floor) continue;
      const amount = t.floor * 2n - (bal ?? 0n);
      const tx = await this.treasury.send((c) => c.transaction(this.treasury.accountId).transfer(t.account, amount).send({ waitUntil: "EXECUTED_OPTIMISTIC" }));
      const hash = (tx as unknown as { transaction?: { hash?: string } }).transaction?.hash ?? "";
      this.log.unshift({ at: Date.now(), account: t.account, amount: amount.toString(), txHash: hash });
      this.log = this.log.slice(0, 50);
    }
  }
}

export async function startTopUp() {
  const net = network();
  const acc = account("TREASURY");
  if (!acc) throw new Error("TREASURY_ACCOUNT and TREASURY_PRIVATE_KEY are required");
  const t = new TopUp(net, new Signer(net, acc), parseTargets(settings.str("TOPUP_TARGETS", "")));
  listen(app("topup", async () => ({ treasury: acc.accountId, targets: t.targets.map((x) => x.account), recent: t.log.slice(0, 10) })), settings.port("topup", 8793), "topup");
  for (;;) {
    await t.step().catch((e) => console.error("topup:", (e as Error).message));
    await new Promise((r) => setTimeout(r, settings.num("TOPUP_EVERY_MS", 300_000)));
  }
}
