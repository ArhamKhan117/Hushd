/**
 * Reference makers: three market makers with different pricing styles, run by Hushd so
 * the desk always has someone to trade with. Anyone can run more with the SDK.
 *
 * - fixed:      a flat spread over the Hyperliquid mid
 * - volatility: the spread follows the last hour's realized volatility
 * - inventory:  the spread widens as its stock of what it gives runs low
 *
 * Each maker opens only the asks sealed to it (pair, side and size: never the
 * trader's limit), signs its consent to the exact terms with its quote key, seals the
 * quote to the matcher enclave, and settles the deals it wins as leg B.
 * It also sells indicative quotes over x402 (free on testnet).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { quoteConsent, type PackageQuote } from "@hushd/protocol";
import {
  bondStepAtLeast,
  CUSTODY,
  CustodyWallet,
  DeskApi,
  deskView,
  fromB64,
  identityFromSeed,
  loadPoseidon,
  openJson,
  paymentRequired,
  paymentResponse,
  PrivateWallet,
  RelayerClient,
  sealJson,
  settleAsMaker,
  toB64,
  tokenInfo,
  verifyX402Payment,
  view,
  x402Network,
  type AgreedTerms,
  type CallSpec,
  type HushdNetwork,
  type MakerAsk,
} from "@hushd/sdk";
import { EncryptedFileStore } from "@hushd/sdk/node";
import { addressOfKey, approveDealAgent, dealAddress } from "./hyperliquid.js";
import { account, network, settings } from "./config.js";
import { Signer } from "./chain.js";
import { app, listen } from "./http.js";
import { type PerpMeta, capByMarket, hourVolBps, intentsQuote, mids, hedgePerps, hedgeTestnet, hedgeWithdrawable, wirePrice, wireSize } from "./market.js";

export type Style = "fixed" | "volatility" | "inventory";

const hexBytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const toHexStr = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

/** USDC of margin a hedge of this notional needs: at half the coin's maximum leverage, so a move does not liquidate it at once. */
export function hedgeMargin(notionalUsd: number, maxLeverage: number): number {
  return notionalUsd / Math.max(1, maxLeverage / 2);
}

/** A tenth of the notional in whole USDC, rounded up to the desk's next bond step (base units; `bondStepAtLeast`). */
export function bondFor(notionalUsd: number, usdcDecimals: number, minBond: bigint): bigint {
  return bondStepAtLeast(BigInt(Math.ceil(notionalUsd * 0.1)) * 10n ** BigInt(usdcDecimals), minBond);
}

/** Spread in basis points for a style. */
export function spreadBps(style: Style, ctx: { volBps: number; inventoryRatio: number }): number {
  if (style === "fixed") return 25;
  // whole basis points: the spread is also used in bigint math (capByMarket)
  if (style === "volatility") return Math.round(Math.min(150, Math.max(15, 10 + 0.6 * ctx.volBps)));
  return Math.round(15 + 60 * Math.max(0, 1 - ctx.inventoryRatio));
}

/** How much of `buy` the maker gives for `sell`, after its spread (rounded down: never more). */
export function priceAsk(p: { sellAmount: bigint; sellDecimals: number; sellUsd: number; buyDecimals: number; buyUsd: number; spreadBps: number }): bigint {
  const sellWhole = Number(p.sellAmount) / 10 ** p.sellDecimals;
  const giveWhole = ((sellWhole * p.sellUsd) / p.buyUsd) * (1 - p.spreadBps / 10_000);
  // scale through a string so large decimals (24) stay exact enough, then floor
  const scaled = BigInt(Math.floor(giveWhole * 1e6)) * 10n ** BigInt(p.buyDecimals) / 1_000_000n;
  return scaled > 0n ? scaled : 0n;
}

export class Maker {
  readonly wallet: PrivateWallet;
  readonly quoteSecret: Uint8Array;
  private seen = new Set<number>();
  private quoted = new Map<number, number>();
  private settling = new Set<number>();
  stats = { asks: 0, quotes: 0, won: 0, settled: 0, errors: 0, lastError: "" };

  constructor(
    readonly net: HushdNetwork,
    readonly name: string,
    readonly style: Style,
    readonly near: MakerAccount,
    seedHex: string,
    quoteKeyHex: string,
    readonly api: DeskApi,
    readonly relayer: RelayerClient,
    dataDir: string,
    /** The maker's Hyperliquid account key (0x hex): approves each hedged deal's MPC address as its agent. */
    private readonly hlKey: string | null = null,
    /** Names the maker's note file, so it survives a change of NEAR account (default: the account). */
    slot: string = near.accountId,
  ) {
    const id = identityFromSeed(hexBytes(seedHex));
    this.quoteSecret = hexBytes(quoteKeyHex);
    mkdirSync(dataDir, { recursive: true });
    this.wallet = new PrivateWallet(net, id, {
      artifacts: { wasm: (n) => join(settings.circuitsDir(), `${n}.wasm`), zkey: (n) => join(settings.circuitsDir(), `${n}.zkey`) },
      relayer,
      store: new EncryptedFileStore(join(dataDir, `${slot}.notes.enc`), hexBytes(seedHex)),
    });
  }

  get account() {
    return this.near.accountId;
  }

  get quoteKey(): string {
    return `ed25519:${base58.encode(ed25519.getPublicKey(this.quoteSecret))}`;
  }

  /** Registered with this quote key and encryption key; register (or update) if not. */
  async ensureRegistered(quoteUrl: string) {
    const me = await view<{ quote_key: string; enc_key: string } | null>(this.net, this.net.desk!, "maker", { account_id: this.account });
    const enc = toHexStr(this.wallet.id.encPublic);
    if (me && me.quote_key === this.quoteKey && me.enc_key === enc) return;
    await this.near.call({ receiver: this.net.desk!, method: "register_maker", args: { name: this.name, enc_key: enc, quote_url: quoteUrl, style: this.style, quote_key: this.quoteKey }, gas: 30n * TGAS, deposit: 10_000_000_000_000_000_000_000n });
  }

  /** Bond up to `target` on the desk from the maker's public USDC (what the owner funded it with). */
  async ensureBonded(target: bigint) {
    const usdc = this.net.bondToken!;
    const me = await view<{ bond: string } | null>(this.net, this.net.desk!, "maker", { account_id: this.account });
    const short = target - BigInt(me?.bond ?? "0");
    if (short <= 0n) return;
    const have = BigInt(await view<string>(this.net, usdc, "ft_balance_of", { account_id: this.account }));
    const amount = have < short ? have : short;
    if (amount <= 0n) return;
    await this.near.call({ receiver: usdc, method: "ft_transfer_call", args: { receiver_id: this.net.desk!, amount: amount.toString(), memo: null, msg: "bond" }, gas: 100n * TGAS, deposit: 1n });
  }

  /** Price an ask and sign the quote, or null when the maker will not quote it. */
  async quote(ask: MakerAsk): Promise<PackageQuote | null> {
    const sell = tokenInfo(this.net, ask.sell.token);
    const buy = tokenInfo(this.net, ask.buyToken);
    const m = await mids();
    const usd = (t: typeof sell) => (t.symbol === "USDC" ? 1 : t.hedgeCoin ? m[t.hedgeCoin] : undefined);
    const sellUsd = usd(sell);
    const buyUsd = usd(buy);
    if (!sellUsd || !buyUsd) return null;
    const risky = buy.hedgeCoin ?? sell.hedgeCoin ?? "BTC";
    const balances = this.wallet.balances();
    const sellAmount = BigInt(ask.sell.amount);
    const notionalUsd = (Number(sellAmount) / 10 ** sell.decimals) * sellUsd;
    const targetGive = (notionalUsd / buyUsd) * 10 ** buy.decimals;
    const inventoryRatio = Number(balances.get(buy.id) ?? 0n) / Math.max(1, targetGive * 4);
    const spread = spreadBps(this.style, { volBps: this.style === "volatility" ? await hourVolBps(risky).catch(() => 50) : 0, inventoryRatio });
    const fromMids = priceAsk({ sellAmount, sellDecimals: sell.decimals, sellUsd, buyDecimals: buy.decimals, buyUsd, spreadBps: spread });
    // NEAR Intents as a second opinion: never quote better than the open market less the spread
    const give = capByMarket(fromMids, await intentsQuote(sell.symbol, buy.symbol, sellAmount).catch(() => null), spread);
    if (give === 0n || (balances.get(buy.id) ?? 0n) < give) return null;

    const now = Date.now();
    const q: PackageQuote = {
      v: 1,
      rfqId: ask.rfqId,
      maker: this.account,
      give: { token: buy.id, amount: give },
      take: { token: sell.id, amount: sellAmount },
      bond: 0n,
      expiresAtMs: now + 5 * 60_000,
      makerAddress: this.wallet.address,
      quoteKey: this.quoteKey,
      signature: "",
    };
    if (ask.kind !== "spot") {
      // never promise a hedge this maker cannot place: it needs a Hyperliquid account with the margin
      if (!this.hlKey) return null;
      const coin = ask.hedge?.coin ?? buy.hedgeCoin;
      const perps = await hedgePerps().catch(() => ({}) as Record<string, PerpMeta>);
      const perp = coin ? perps[coin] : undefined;
      const px = coin ? m[coin] : undefined;
      if (!coin || !perp || !px) return null;
      if ((await this.hlMargin()) < hedgeMargin(notionalUsd, perp.maxLeverage)) return null;
      const size = Number(give) / 10 ** buy.decimals;
      q.hedge = { venue: "hyperliquid", coin, asset: perp.asset, isBuy: false, size: wireSize(size, perp.szDecimals), limitPx: wirePrice(px * 0.99, perp.szDecimals), deadlineMs: now + 10 * 60_000, testnet: hedgeTestnet() };
      // about a tenth of the trade's value in USDC, held by the desk until the hedge leg is done
      const usdc = this.net.tokens.find((t) => t.symbol === "USDC")!;
      const minBond = await this.minBond();
      q.bond = bondFor(notionalUsd, usdc.decimals, minBond);
      // a hedged quote locks bond: skip it when this maker's free bond cannot cover it
      if (q.bond > (await this.freeBond())) return null;
    }
    // consent v2: this desk, these terms, this class and exactly this hedge leg
    q.signature = toB64(ed25519.sign(quoteConsent(this.net.desk!, q, ask.kind, ask.salt), this.quoteSecret));
    return q;
  }

  /** One round: answer new asks, settle new wins. */
  private enclaveCache: { at: number; encKey: string | null } = { at: 0, encKey: null };
  private minBondCache: { at: number; value: bigint } = { at: 0, value: 0n };

  /** The desk's minimum bond, read every ten minutes (it changes only through a timelock). */
  private async minBond(): Promise<bigint> {
    if (Date.now() - this.minBondCache.at > 600_000) this.minBondCache = { at: Date.now(), value: BigInt((await deskView.config(this.net)).min_bond) };
    return this.minBondCache.value;
  }

  /** Margin free on this maker's Hyperliquid account, read at most every 30 seconds. */
  private hlMarginCache: { at: number; value: number } = { at: 0, value: 0 };
  private async hlMargin(): Promise<number> {
    if (!this.hlKey) return 0;
    if (Date.now() - this.hlMarginCache.at > 30_000) this.hlMarginCache = { at: Date.now(), value: await hedgeWithdrawable(addressOfKey(this.hlKey)).catch(() => 0) };
    return this.hlMarginCache.value;
  }

  /** Bond posted on the desk and not locked in a deal. */
  private async freeBond(): Promise<bigint> {
    const me = await view<{ bond: string; locked: string } | null>(this.net, this.net.desk!, "maker", { account_id: this.account });
    return me ? BigInt(me.bond) - BigInt(me.locked) : 0n;
  }

  async step() {
    // the enclave key changes only on refresh_enclave_key: read it once a minute, not every step
    if (Date.now() - this.enclaveCache.at > 60_000) this.enclaveCache = { at: Date.now(), encKey: (await deskView.enclave(this.net)).enc_key };
    const enclave = { enc_key: this.enclaveCache.encKey };
    if (!enclave.enc_key) return;
    for (const r of await this.api.openRfqs(this.account)) {
      if (this.seen.has(r.rfqId)) continue;
      this.seen.add(r.rfqId);
      const ask = openJson<MakerAsk>(this.wallet.id.encSecret, fromB64(r.box));
      if (!ask || ask.rfqId !== r.rfqId) continue;
      this.stats.asks++;
      const q = await this.quote(ask).catch((e) => {
        this.fail(e);
        return null;
      });
      if (!q) continue;
      await this.api.postQuote(r.rfqId, this.account, toB64(sealJson(hexBytes(enclave.enc_key), JSON.parse(JSON.stringify(q, (_k, v) => (typeof v === "bigint" ? v.toString() : v))))));
      this.quoted.set(r.rfqId, Date.now());
      this.stats.quotes++;
    }
    for (const [rfqId, at] of this.quoted) {
      const res = await this.api.result(rfqId).catch(() => null);
      if (!res || res.status === "open" || res.status === "matching") {
        if (Date.now() - at > 15 * 60_000) this.quoted.delete(rfqId);
        continue;
      }
      this.quoted.delete(rfqId);
      if (res.status !== "matched" || res.dealId == null || !res.for_maker) continue;
      const won = openJson<{ terms: AgreedTerms; trader_address: string }>(this.wallet.id.encSecret, fromB64(res.for_maker));
      if (!won || won.terms.maker !== this.account || this.settling.has(res.dealId)) continue;
      this.stats.won++;
      if (won.terms.hedge) {
        // the deal's own address trades on this maker's margin, approved before the hedge is signed
        if (!this.hlKey) this.fail(new Error(`deal ${res.dealId} needs a hedge but this maker has no Hyperliquid key`));
        else
          await dealAddress(this.net, res.dealId)
            .then((agent) => approveDealAgent(this.hlKey!, agent, won.terms.hedge!.testnet))
            .catch((e) => this.fail(e));
      }
      this.settling.add(res.dealId);
      void settleAsMaker({ net: this.net, api: this.api, relayer: this.relayer, wallet: this.wallet, dealId: res.dealId, terms: won.terms, traderAddress: won.trader_address, quoteSecret: this.quoteSecret })
        .then(() => this.stats.settled++)
        .catch((e) => this.fail(e))
        .finally(() => this.settling.delete(res.dealId!));
    }
  }

  private fail(e: unknown) {
    this.stats.errors++;
    this.stats.lastError = (e as Error).message;
    console.error(`${this.name}:`, this.stats.lastError);
  }
}

/** Payment commitments already accepted, kept on disk so a restart cannot replay them. */
class SeenFile {
  private set: Set<string>;
  constructor(private readonly path: string) {
    this.set = new Set(existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  }
  has(c: string) {
    return this.set.has(c);
  }
  add(c: string) {
    this.set.add(c);
    appendFileSync(this.path, `${c}\n`);
  }
}

/**
 * Private x402 indicative quotes: `GET /makers/:account/quote?sell=&amount=&buy=`.
 * The price (X402_QUOTE_PRICE, USDC base units) is paid from a private balance to the
 * maker's hushd1… address; see packages/sdk/src/x402.ts.
 */
function x402Routes(a: ReturnType<typeof app>, makers: Maker[], net: HushdNetwork, dataDir: string) {
  const usdc = net.tokens.find((t) => t.symbol === "USDC")!;
  const price = settings.str("X402_QUOTE_PRICE", "10000");
  const seen = new Map(makers.map((m) => [m.account, new SeenFile(join(dataDir, `${m.account}.x402-seen`))]));
  a.get("/makers/:account/quote", async (c) => {
    const id = c.req.param("account");
    const m = makers.find((x) => x.account === id || x.name.toLowerCase() === id.toLowerCase());
    if (!m) return c.json({ error: "No such maker here" }, 404);
    const sell = c.req.query("sell");
    const buy = c.req.query("buy");
    const amount = c.req.query("amount");
    if (!sell || !buy || !amount || !/^\d+$/.test(amount)) return c.json({ error: "sell, buy and amount (base units) are required" }, 400);
    const required = paymentRequired(net, { maxAmountRequired: price, asset: usdc.id, payTo: m.wallet.address, resource: c.req.url, description: `One indicative quote from ${m.name}`, mimeType: "application/json" });
    const header = c.req.header("x-payment");
    if (!header) return c.json(required, 402);
    const paid = await verifyX402Payment(net, m.wallet.id, header, { asset: usdc.id, maxAmountRequired: price }, seen.get(m.account)!);
    if (!paid.ok) return c.json({ ...required, error: paid.reason }, 402);
    const q = await m.quote({ v: 1, rfqId: 0, kind: "spot", sell: { token: sell, amount }, buyToken: buy, closesAtMs: Date.now() + 60_000 });
    const headers = { "x-payment-response": paymentResponse({ txHash: paid.txHash, network: x402Network(net) }) };
    if (!q) return c.json({ error: "No quote for this pair or size right now", paid: true }, 409, headers);
    return c.json({ maker: m.account, style: m.style, give: { token: q.give.token, amount: q.give.amount.toString() }, take: { token: q.take.token, amount: q.take.amount.toString() }, indicative: true, validMs: 30_000 }, 200, headers);
  });
}

/** A maker's NEAR account: an OutLayer policy wallet (the key stays in a TEE), or its own key. */
export interface MakerAccount {
  accountId: string;
  kind: "policy-wallet" | "key";
  call(c: CallSpec): Promise<string>;
}

const TGAS = 1_000_000_000_000n;

export function makerAccount(net: HushdNetwork, prefix: string): MakerAccount | null {
  const walletKey = process.env[`${prefix}_POLICY_WALLET_KEY`];
  const walletAccount = process.env[`${prefix}_POLICY_WALLET_ACCOUNT`];
  if (walletKey && walletAccount) {
    const w = new CustodyWallet(walletKey, settings.str("CUSTODY_URL", CUSTODY[net.id].api));
    return { accountId: walletAccount, kind: "policy-wallet", call: async (c) => (await w.call(c)).txHash };
  }
  const acc = account(prefix);
  if (!acc) return null;
  const signer = new Signer(net, acc);
  return { accountId: acc.accountId, kind: "key", call: async (c) => (await signer.call(c.receiver, c.method, c.args, { gas: `${Number(c.gas / TGAS)} Tgas`, deposit: c.deposit })).txHash };
}

export async function startMakers() {
  const net = network();
  await loadPoseidon();
  const relayer = new RelayerClient(settings.str("RELAYER_URL", "http://localhost:8787"));
  const api = new DeskApi(settings.str("API_URL", "http://localhost:8788"));
  const publicUrl = settings.str("MAKERS_PUBLIC_URL", "https://api.hushd.net");
  const makers: Maker[] = [];
  for (const [prefix, style] of [["MAKER_A", "fixed"], ["MAKER_B", "volatility"], ["MAKER_C", "inventory"]] as const) {
    const near = makerAccount(net, prefix);
    const seed = process.env[`${prefix}_SEED`];
    const quoteKey = process.env[`${prefix}_QUOTE_KEY`];
    if (!near || !seed || !quoteKey) continue;
    const name = settings.str(`${prefix}_NAME`, { fixed: "Steady", volatility: "Weather", inventory: "Ledger" }[style]);
    const slot = prefix.toLowerCase().replace("_", "-");
    makers.push(new Maker(net, name, style, near, seed, quoteKey, api, relayer, settings.str("MAKERS_DATA_DIR", "./data/makers"), process.env[`${prefix}_HL_KEY`] || null, slot));
  }
  if (makers.length === 0) throw new Error("No maker configured (MAKER_A_SEED, _QUOTE_KEY, and _POLICY_WALLET_KEY or _ACCOUNT with _PRIVATE_KEY)");
  // the bond each maker keeps on the desk: 20,000 test USDC on testnet, 1,000 real USDC on mainnet (scripts/deploy.ts)
  const bondTarget = BigInt(settings.str("MAKER_BOND", net.id === "mainnet" ? "1000000000" : "20000000000"));
  for (const m of makers) {
    await m.wallet.restore();
    await m.ensureRegistered(`${publicUrl}/makers/${m.account}/quote`).catch((e) => console.error(`${m.name} register:`, (e as Error).message));
    await m.ensureBonded(bondTarget).catch((e) => console.error(`${m.name} bond:`, (e as Error).message));
  }
  const a = app("makers", async () => ({ makers: makers.map((m) => ({ account: m.account, style: m.style, ...m.stats, balances: Object.fromEntries([...m.wallet.balances()].map(([k, v]) => [k, v.toString()])) })) }));
  x402Routes(a, makers, net, settings.str("MAKERS_DATA_DIR", "./data/makers"));
  listen(a, settings.port("makers", 8791), "makers");
  let lastSync = 0;
  for (;;) {
    if (Date.now() - lastSync > 20_000) {
      await Promise.all(makers.map((m) => m.wallet.sync().catch((e) => console.error(`${m.name} sync:`, (e as Error).message))));
      lastSync = Date.now();
    }
    await Promise.all(makers.map((m) => m.step().catch((e) => console.error(`${m.name}:`, (e as Error).message))));
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
