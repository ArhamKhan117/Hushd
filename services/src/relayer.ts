/// <reference path="../../packages/sdk/src/circomlibjs.d.ts" />
/**
 * The Hushd relayer. It sends proven pool actions, board posts and desk actions from
 * its own account (spread over gas-key lanes), so a user's NEAR account never appears
 * as the sender. Before sending anything it dry-runs it: the proof is checked off
 * chain against the exact public inputs the contract will rebuild, the root must be
 * known and the notes unspent. An allowlist, per-client rate limits and a daily gas
 * budget bound what it will pay for.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountBalance, assetField, extHash, poolView, settleMessage, swapExtHash, view, type HushdNetwork } from "@hushd/sdk";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { decodeSignedDelegateAction } from "near-kit";
import * as snarkjs from "snarkjs";
import { account, network, settings } from "./config.js";
import { Signer } from "./chain.js";
import { app, BadRequest, listen, rateLimit } from "./http.js";

const MAX_POST_BYTES = 2048;

interface Leg {
  proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
  root: string;
  nullifiers: [string, string];
  commitments: [string, string];
}

const isField = (s: unknown): s is string => typeof s === "string" && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(s);
const big = (s: string) => BigInt(s);

/** Methods the contracts accept only with exactly 1 yoctoNEAR attached. */
export const ONE_YOCTO_METHODS = new Set(["ft_transfer_call", "set_maker_active", "withdraw_bond"]);

type DecodedDelegate = {
  signedDelegate?: { delegateAction?: { receiverId: string; actions: { functionCall?: { methodName: string; deposit: bigint | string } }[] } };
};

/** Check a decoded NEP-366 delegate against the allowlist before paying its gas. */
export function checkDelegate(allow: Record<string, string[]>, decoded: DecodedDelegate) {
  const da = decoded.signedDelegate?.delegateAction;
  if (!da) throw new BadRequest("Not a signed delegate action");
  const allowed = allow[da.receiverId];
  if (!allowed) throw new BadRequest("The relayer does not send to that contract");
  for (const act of da.actions) {
    const fc = act.functionCall;
    if (!fc || !allowed.includes(fc.methodName)) throw new BadRequest("Only allowlisted function calls are relayed");
    if (ONE_YOCTO_METHODS.has(fc.methodName) && BigInt(fc.deposit) !== 1n) throw new BadRequest(`${fc.methodName} takes exactly 1 yoctoNEAR`);
  }
}

export class Relayer {
  private vkey: unknown;
  private spentToday = { day: "", gas: 0n };
  private activations = { day: "", count: 0 };

  constructor(
    readonly net: HushdNetwork,
    readonly signer: Signer,
    private readonly opts: { dailyGasBudget: bigint; cashOutFeeBps: number; circuitsDir: string; activateYocto?: bigint; activationsPerDay?: number },
  ) {
    this.vkey = JSON.parse(readFileSync(join(opts.circuitsDir, "joinsplit.vkey.json"), "utf8"));
  }

  allow(): Record<string, string[]> {
    const a: Record<string, string[]> = {};
    if (this.net.pool) a[this.net.pool] = ["transact"];
    if (this.net.board) a[this.net.board] = ["post", "storage_deposit"];
    if (this.net.desk) a[this.net.desk] = ["open_rfq", "settle", "close_hedge", "register_maker", "set_maker_active", "withdraw_bond"];
    for (const t of this.net.tokens) a[t.id] = ["faucet_for", "ft_transfer_call", "storage_deposit"];
    return a;
  }

  private budget(gas: bigint) {
    const day = new Date().toISOString().slice(0, 10);
    if (this.spentToday.day !== day) this.spentToday = { day, gas: 0n };
    if (this.spentToday.gas + gas > this.opts.dailyGasBudget) throw new BadRequest("The relayer's daily budget is used up; try again tomorrow");
  }

  private charge(gas: bigint) {
    this.spentToday.gas += gas;
  }

  private async verifyJoinsplit(inputs: bigint[], proof: Leg["proof"]): Promise<void> {
    const ok = await snarkjs.groth16.verify(this.vkey, inputs.map(String), proof);
    if (!ok) throw new BadRequest("The proof does not verify for these arguments");
  }

  private async checkSpendable(root: string, nullifiers: string[]): Promise<void> {
    if (!(await poolView.isKnownRoot(this.net, big(root)))) throw new BadRequest("The proof names a root the pool does not know (sync and prove again)");
    for (const n of nullifiers) if (await poolView.isSpent(this.net, big(n))) throw new BadRequest("A note in this proof is already spent");
    if (new Set(nullifiers.map((n) => big(n))).size !== nullifiers.length) throw new BadRequest("A note appears twice");
  }

  /** Dry run then send `pool.transact`. */
  async transact(body: { proof: Leg["proof"]; args: Record<string, unknown> }) {
    const a = body.args as {
      root: string; nullifiers: string[]; commitments: string[]; public_amount: string; token: string | null;
      ext: { recipient: string | null; relayer: string | null; fee: string; refund_inner: string | null; memo: string | null };
    };
    if (!a || !isField(a.root) || a.nullifiers?.length !== 2 || a.commitments?.length !== 2 || ![...a.nullifiers, ...a.commitments].every(isField)) {
      throw new BadRequest("Malformed transact arguments");
    }
    const publicAmount = BigInt(a.public_amount ?? "0");
    const ext = a.ext ?? { recipient: null, relayer: null, fee: "0", refund_inner: null, memo: null };
    const fee = BigInt(ext.fee ?? "0");
    if (publicAmount > 0n) {
      if (!a.token || !this.net.tokens.some((t) => t.id === a.token)) throw new BadRequest("Unknown token");
      if (fee > 0n && ext.relayer !== this.signer.accountId) throw new BadRequest("A fee must name this relayer");
      const minFee = (publicAmount * BigInt(this.opts.cashOutFeeBps)) / 10_000n;
      if (fee < minFee) throw new BadRequest(`This relayer asks a fee of at least ${minFee}`);
    }
    const inputs = [
      big(a.root), big(a.nullifiers[0]!), big(a.nullifiers[1]!), big(a.commitments[0]!), big(a.commitments[1]!),
      publicAmount, publicAmount > 0n ? assetField(a.token!) : 0n,
      extHash({ recipient: ext.recipient, relayer: ext.relayer, fee, refundInner: ext.refund_inner ? big(ext.refund_inner) : null, memo: ext.memo }),
    ];
    await this.verifyJoinsplit(inputs, body.proof);
    await this.checkSpendable(a.root, a.nullifiers);
    this.budget(300_000_000_000_000n);
    const r = await this.signer.call(this.net.pool!, "transact", { proof: body.proof, args: a }, { gas: "300 Tgas", deposit: 10_000_000_000_000_000_000_000n });
    this.charge(r.gasBurnt);
    return { txHash: r.txHash, result: r.result, lane: r.lane };
  }

  /** Board post: the relayer's own storage balance pays, topped up when low. */
  async post(body: { data: string; tag?: string }) {
    if (typeof body.data !== "string") throw new BadRequest("data is base64");
    const bytes = Buffer.from(body.data, "base64");
    if (bytes.length === 0 || bytes.length > MAX_POST_BYTES) throw new BadRequest(`A post is 1 to ${MAX_POST_BYTES} bytes`);
    if (body.tag !== undefined && (typeof body.tag !== "string" || body.tag.length > 32)) throw new BadRequest("tag is at most 32 characters");
    await this.ensureBoardStorage(BigInt(bytes.length + 400) * 10_000_000_000_000_000_000n);
    this.budget(30_000_000_000_000n);
    const r = await this.signer.call(this.net.board!, "post", { ciphertext: body.data, tag: body.tag ?? null }, { gas: "30 Tgas" });
    this.charge(r.gasBurnt);
    return { txHash: r.txHash, result: r.result };
  }

  private async ensureBoardStorage(need: bigint) {
    const bal = await view<{ total: string; available: string } | null>(this.net, this.net.board!, "storage_balance_of", { account_id: this.signer.accountId });
    if (!bal || BigInt(bal.available) < need * 4n) {
      await this.signer.call(this.net.board!, "storage_deposit", { account_id: null, registration_only: null }, { gas: "30 Tgas", deposit: 200_000_000_000_000_000_000_000n });
    }
  }

  async openRfq(body: { commitment: string; windowMs: number }) {
    if (!/^0x[0-9a-f]{64}$/.test(body.commitment ?? "")) throw new BadRequest("commitment is 0x hex, 32 bytes");
    const w = Number(body.windowMs);
    if (!Number.isInteger(w) || w < 1_000 || w > 3_600_000) throw new BadRequest("windowMs between 1 s and 1 h");
    this.budget(20_000_000_000_000n);
    const r = await this.signer.call(this.net.desk!, "open_rfq", { commitment: body.commitment, window_ms: String(w) }, { gas: "20 Tgas", deposit: 10_000_000_000_000_000_000_000n });
    this.charge(r.gasBurnt);
    return { txHash: r.txHash, rfqId: Number(r.result), result: r.result };
  }

  /** Dry-run both legs against the deal's binding and check both parties' approvals, then `desk.settle`. */
  async settle(body: { dealId: number; legs: Leg[]; approvals: { trader: string; maker: string } }) {
    const dealId = BigInt(body.dealId);
    const legs = body.legs;
    if (!Array.isArray(legs) || legs.length !== 2) throw new BadRequest("Two legs");
    await this.checkApprovals(Number(dealId), legs, body.approvals);
    const binding = swapExtHash(dealId, legs[0]!.commitments.map(big) as [bigint, bigint], legs[1]!.commitments.map(big) as [bigint, bigint]);
    for (const l of legs) {
      await this.verifyJoinsplit([big(l.root), big(l.nullifiers[0]), big(l.nullifiers[1]), big(l.commitments[0]), big(l.commitments[1]), 0n, 0n, binding], l.proof);
      await this.checkSpendable(l.root, l.nullifiers);
    }
    const deal = await view<{ status: string } | null>(this.net, this.net.desk!, "deal", { deal_id: String(dealId) });
    if (!deal) throw new BadRequest("No such deal");
    if (deal.status !== "matched") throw new BadRequest(`The deal is ${deal.status}`);
    this.budget(300_000_000_000_000n);
    const r = await this.signer.call(this.net.desk!, "settle", { deal_id: String(dealId), legs, approvals: body.approvals }, { gas: "300 Tgas", deposit: 20_000_000_000_000_000_000_000n });
    this.charge(r.gasBurnt);
    return { txHash: r.txHash, result: r.result };
  }

  /** The desk refuses legs both parties did not approve; check here first so no gas is spent on them. */
  private async checkApprovals(dealId: number, legs: Leg[], approvals: { trader: string; maker: string } | undefined) {
    if (typeof approvals?.trader !== "string" || typeof approvals?.maker !== "string") throw new BadRequest("approvals: the trader's and the maker's signatures");
    const deal = await view<{ maker: string; owner_key: string | null } | null>(this.net, this.net.desk!, "deal", { deal_id: String(dealId) });
    if (!deal) throw new BadRequest("No such deal");
    const maker = await view<{ quote_key: string } | null>(this.net, this.net.desk!, "maker", { account_id: deal.maker });
    const message = new TextEncoder().encode(settleMessage(this.net, dealId, [...legs[0]!.commitments, ...legs[1]!.commitments] as [string, string, string, string]));
    const ok = (sig: string, key: string | null | undefined) => {
      const bytes = Buffer.from(sig, "base64");
      return Boolean(key?.startsWith("ed25519:")) && bytes.length === 64 && ed25519.verify(bytes, message, base58.decode(key!.slice(8)));
    };
    if (!ok(approvals.trader, deal.owner_key)) throw new BadRequest("The trader did not approve these legs");
    if (!ok(approvals.maker, maker?.quote_key)) throw new BadRequest("The maker did not approve these legs");
  }

  /** Testnet faucet for an account that has no gas yet (a fresh passkey account). */
  async faucet(body: { account: string; token: string }) {
    if (this.net.id !== "testnet") throw new BadRequest("The faucet is testnet only");
    const t = this.net.tokens.find((x) => x.id === body.token || x.symbol.toLowerCase() === String(body.token).toLowerCase());
    if (!t) throw new BadRequest("Unknown token");
    if (!/^[a-z0-9._-]{2,64}$/.test(body.account ?? "")) throw new BadRequest("Not a NEAR account id");
    this.budget(20_000_000_000_000n);
    const r = await this.signer.call(t.id, "faucet_for", { account_id: body.account }, { gas: "20 Tgas" });
    this.charge(r.gasBurnt);
    return { txHash: r.txHash, result: r.result };
  }

  /** Close a hedge for its trader: `desk.close_hedge` checks the owner key's signature. */
  async closeHedge(body: { dealId: number; signature: string }) {
    if (!Number.isInteger(body.dealId) || body.dealId < 0) throw new BadRequest("dealId");
    if (typeof body.signature !== "string" || Buffer.from(body.signature, "base64").length !== 64) throw new BadRequest("signature is 64 bytes, base64");
    this.budget(300_000_000_000_000n);
    const r = await this.signer.call(this.net.desk!, "close_hedge", { deal_id: String(body.dealId), signature: body.signature }, { gas: "300 Tgas" });
    this.charge(r.gasBurnt);
    return { txHash: r.txHash, result: r.result };
  }

  /**
   * Testnet: open a fresh passkey account (an implicit account, 64 hex) with a little
   * NEAR for its own gas. Only accounts that do not exist yet, a daily cap overall.
   */
  async activate(body: { account: string }) {
    if (this.net.id !== "testnet") throw new BadRequest("Activation is testnet only");
    if (!/^[0-9a-f]{64}$/.test(body.account ?? "")) throw new BadRequest("Only a new implicit account (64 hex) is activated");
    if ((await accountBalance(this.net, body.account)) !== null) return { activated: false, reason: "exists" };
    const day = new Date().toISOString().slice(0, 10);
    if (this.activations.day !== day) this.activations = { day, count: 0 };
    if (this.activations.count >= (this.opts.activationsPerDay ?? 200)) throw new BadRequest("Today's activations are used up; connect a NEAR wallet instead");
    this.activations.count += 1;
    // enough to prepay a deposit's gas at testnet prices (about 0.1 NEAR for 100 Tgas); unused gas comes back
    const amount = this.opts.activateYocto ?? 200_000_000_000_000_000_000_000n;
    const tx = (await this.signer.send((c) => c.transaction(this.signer.accountId).transfer(body.account, amount).send({ waitUntil: "EXECUTED_OPTIMISTIC" }))) as unknown as { transaction?: { hash?: string } };
    return { activated: true, amount: amount.toString(), txHash: tx.transaction?.hash ?? "" };
  }

  /** NEP-366 meta transaction: a maker's own action (deposits come from the maker), gas paid by the relayer. */
  async meta(body: { signedDelegate: string }) {
    let sd: ReturnType<typeof decodeSignedDelegateAction>;
    try {
      sd = decodeSignedDelegateAction(body.signedDelegate);
    } catch {
      throw new BadRequest("signedDelegate is a base64 NEP-366 signed delegate action");
    }
    checkDelegate(this.allow(), sd as unknown as DecodedDelegate);
    this.budget(100_000_000_000_000n);
    const outcome = (await this.signer.send((c) => c.transaction(this.signer.accountId).signedDelegateAction(sd as never).send({ waitUntil: "EXECUTED_OPTIMISTIC" }))) as unknown as { transaction?: { hash?: string } };
    return { txHash: outcome.transaction?.hash ?? "" };
  }

  info() {
    return { account: this.signer.accountId, network: this.net.id, cashOutFeeBps: this.opts.cashOutFeeBps, allow: this.allow(), lanes: this.signer.lanes, spentToday: this.spentToday.gas.toString() };
  }
}

export async function startRelayer() {
  const net = network();
  const acc = account("RELAYER");
  if (!acc) throw new Error("RELAYER_ACCOUNT and RELAYER_PRIVATE_KEY are required");
  const signer = new Signer(net, acc);
  const relayer = new Relayer(net, signer, {
    dailyGasBudget: BigInt(settings.str("RELAYER_DAILY_GAS", "300000000000000000")),
    cashOutFeeBps: settings.num("RELAYER_CASHOUT_FEE_BPS", net.id === "testnet" ? 0 : 50),
    circuitsDir: settings.circuitsDir(),
    activateYocto: BigInt(settings.str("RELAYER_ACTIVATE_YOCTO", "200000000000000000000000")),
    activationsPerDay: settings.num("RELAYER_ACTIVATIONS_PER_DAY", 200),
  });
  const a = app("relayer", async () => ({ account: signer.accountId, balance: (await signer.balance()).toString(), lanes: signer.snapshot() }));
  a.use("/v1/relay/*", rateLimit(settings.num("RELAYER_PER_MINUTE", 30)));
  a.get("/v1/relay/info", (c) => c.json(relayer.info()));
  a.get("/v1/relay/lanes", (c) => c.json(signer.snapshot()));
  a.post("/v1/relay/transact", async (c) => c.json(await relayer.transact(await c.req.json())));
  a.post("/v1/relay/post", async (c) => c.json(await relayer.post(await c.req.json())));
  a.post("/v1/relay/rfq", async (c) => c.json(await relayer.openRfq(await c.req.json())));
  a.post("/v1/relay/settle", async (c) => c.json(await relayer.settle(await c.req.json())));
  a.post("/v1/relay/faucet", async (c) => c.json(await relayer.faucet(await c.req.json())));
  a.post("/v1/relay/close-hedge", async (c) => c.json(await relayer.closeHedge(await c.req.json())));
  a.post("/v1/relay/activate", async (c) => c.json(await relayer.activate(await c.req.json())));
  a.post("/v1/relay/meta", async (c) => c.json(await relayer.meta(await c.req.json())));
  listen(a, settings.port("relayer", 8787), "relayer");
}
