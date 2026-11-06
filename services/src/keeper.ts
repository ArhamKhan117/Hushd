/**
 * The keeper: keeps deals moving to a receipt.
 *
 * - Expires matched deals nobody settled in time (receipt: failed).
 * - Runs each bonded hedge leg: asks the desk to have the MPC sign the deal's own
 *   order (the desk rebuilds it from the deal; the keeper cannot change it), submits it
 *   to Hyperliquid testnet from the deal's own address, and records the fill or the
 *   rejection. A rejection before the deadline lets the desk sign the order again (up to
 *   three attempts); the last rejection or a missed deadline slashes the maker's bond.
 * - Retries a slashed bond the pool refused (deposits paused, a limit).
 */
import { deskView, type DealView, type HushdNetwork } from "@hushd/sdk";
import { account, network, settings } from "./config.js";
import { Signer } from "./chain.js";
import { app, listen } from "./http.js";

/** The desk signs a hedge leg's opening order at most this many times (MAX_HEDGE_ATTEMPTS in contracts/desk). */
const MAX_HEDGE_ATTEMPTS = 3;
/** How often a refused slash payout is sent to the pool again. */
const SLASH_RETRY_MS = 10 * 60_000;

const HL_EXCHANGE = () => settings.str("HYPERLIQUID_TESTNET_EXCHANGE_URL", "https://api.hyperliquid-testnet.xyz/exchange");

type MpcSignature = { big_r?: string | { affine_point: string }; s?: string | { scalar: string }; recovery_id?: number };

/** MPC secp256k1 output to Hyperliquid's {r, s, v}. */
export function toRsv(sig: MpcSignature): { r: string; s: string; v: number } {
  const bigR = typeof sig.big_r === "string" ? sig.big_r : sig.big_r?.affine_point;
  const s = typeof sig.s === "string" ? sig.s : sig.s?.scalar;
  if (!bigR || !s || sig.recovery_id === undefined) throw new Error("unreadable MPC signature");
  return { r: `0x${bigR.slice(2).padStart(64, "0")}`, s: `0x${s.padStart(64, "0")}`, v: 27 + sig.recovery_id };
}

/** The order action exactly as the desk hashed it (same keys, same order). */
export function orderAction(h: NonNullable<DealView["hedge"]>, close: boolean) {
  return {
    type: "order",
    orders: [{ a: h.asset, b: close ? !h.is_buy : h.is_buy, p: h.limit_px, s: h.size, r: close, t: { limit: { tif: "Ioc" } } }],
    grouping: "na",
  };
}

type HlStatus = { filled?: { totalSz: string; avgPx: string; oid: number }; resting?: { oid: number }; error?: string };

export class Keeper {
  stats = { expired: 0, hedgesSigned: 0, filled: 0, rejected: 0, slashed: 0, slashRetries: 0, lastError: "" };
  private slashRetriedAt = new Map<string, number>();
  constructor(readonly net: HushdNetwork, readonly signer: Signer) {}

  async step(now = Date.now()) {
    const deals = await deskView.deals(this.net, 100);
    for (const d of deals) {
      try {
        if (d.status === "matched" && Number(d.expires_at_ms) < now) {
          await this.signer.call(this.net.desk!, "expire", { deal_id: d.id }, { gas: "30 Tgas" });
          this.stats.expired++;
        } else if (d.status === "hedge_pending" && d.hedge) {
          if (now > d.hedge.deadline_ms) {
            await this.signer.call(this.net.desk!, "slash_overdue", { deal_id: d.id }, { gas: "200 Tgas" });
            this.stats.slashed++;
          } else if (d.hedge_orders === 0 && d.hedge_attempts < MAX_HEDGE_ATTEMPTS) {
            await this.runHedge(d);
          }
        } else if (d.status === "slash_refused" && now - (this.slashRetriedAt.get(d.id) ?? 0) > SLASH_RETRY_MS) {
          // the pool refused the payout (paused, a limit): try again now and then, not every round
          this.slashRetriedAt.set(d.id, now);
          await this.signer.call(this.net.desk!, "retry_slash_payout", { deal_id: d.id }, { gas: "150 Tgas" });
          this.stats.slashRetries++;
        }
      } catch (e) {
        this.stats.lastError = `deal ${d.id}: ${(e as Error).message}`;
        console.error("keeper:", this.stats.lastError);
      }
    }
  }

  async runHedge(d: DealView) {
    const signed = await this.signer.call(this.net.desk!, "sign_hedge_order", { deal_id: d.id }, { gas: "250 Tgas" });
    this.stats.hedgesSigned++;
    const out = signed.result as { nonce: string; signature: MpcSignature } | null;
    if (!out) throw new Error("the MPC did not sign");
    const body = { action: orderAction(d.hedge!, false), nonce: Number(out.nonce), signature: toRsv(out.signature), vaultAddress: null };
    const res = await fetch(HL_EXCHANGE(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const json = (await res.json().catch(() => ({ status: "err", response: `HTTP ${res.status}` }))) as { status: string; response: unknown };
    const status = json.status === "ok" ? ((json.response as { data?: { statuses?: HlStatus[] } }).data?.statuses?.[0] ?? {}) : { error: String(json.response) };
    const filled = !!status.filled;
    const evidence = filled
      ? [{ kind: "hyperliquid_fill", reference: `oid ${status.filled!.oid}: ${status.filled!.totalSz} ${d.hedge!.coin} at ${status.filled!.avgPx}, nonce ${out.nonce}` }]
      : [{ kind: "hyperliquid_reject", reference: (status.error ?? (status.resting ? `resting oid ${status.resting.oid}` : "no fill")).slice(0, 200) }];
    await this.signer.call(this.net.desk!, "record_hedge", { deal_id: d.id, filled, evidence }, { gas: "200 Tgas" });
    if (filled) this.stats.filled++;
    else this.stats.rejected++;
  }
}

export async function startKeeper() {
  const net = network();
  const acc = account("KEEPER");
  if (!acc) throw new Error("KEEPER_ACCOUNT and KEEPER_PRIVATE_KEY are required");
  const k = new Keeper(net, new Signer(net, acc));
  listen(app("keeper", async () => ({ account: acc.accountId, ...k.stats })), settings.port("keeper", 8792), "keeper");
  for (;;) {
    await k.step().catch((e) => console.error("keeper:", (e as Error).message));
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
