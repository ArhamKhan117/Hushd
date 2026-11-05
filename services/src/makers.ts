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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { base58 } from "@scure/base";
import { consentBytes, termsHash, termsOf, type PackageQuote } from "@hushd/protocol";
import {
  DeskApi,
  deskView,
  identityFromSeed,
  loadPoseidon,
  openJson,
  PrivateWallet,
  RelayerClient,
  sealJson,
  settleAsMaker,
  toB64,
  tokenInfo,
  view,
  type AgreedTerms,
  type HushdNetwork,
  type MakerAsk,
  type NoteStore,
  type StoredNote,
} from "@hushd/sdk";
import { account, network, settings } from "./config.js";
import { Signer } from "./chain.js";
import { app, listen } from "./http.js";
import { hourVolBps, mids, testnetPerps, wirePrice, wireSize } from "./market.js";

export type Style = "fixed" | "volatility" | "inventory";

const hexBytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const toHexStr = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;

class FileStore implements NoteStore {
  constructor(private readonly path: string) {}
  async load() {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as { notes: StoredNote[]; boardCursor: number }) : null;
  }
  async save(s: { notes: StoredNote[]; boardCursor: number }) {
    writeFileSync(this.path, JSON.stringify(s));
  }
}

/** Spread in basis points for a style. */
export function spreadBps(style: Style, ctx: { volBps: number; inventoryRatio: number }): number {
  if (style === "fixed") return 25;
  if (style === "volatility") return Math.min(150, Math.max(15, 10 + 0.6 * ctx.volBps));
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
    readonly signer: Signer,
    seedHex: string,
    quoteKeyHex: string,
    readonly api: DeskApi,
    readonly relayer: RelayerClient,
    dataDir: string,
  ) {
    const id = identityFromSeed(hexBytes(seedHex));
    this.quoteSecret = hexBytes(quoteKeyHex);
    mkdirSync(dataDir, { recursive: true });
    this.wallet = new PrivateWallet(net, id, {
      artifacts: { wasm: (n) => join(settings.circuitsDir(), `${n}.wasm`), zkey: (n) => join(settings.circuitsDir(), `${n}.zkey`) },
      relayer,
      store: new FileStore(join(dataDir, `${signer.accountId}.notes.json`)),
    });
  }

  get account() {
    return this.signer.accountId;
  }

  get quoteKey(): string {
    return `ed25519:${base58.encode(ed25519.getPublicKey(this.quoteSecret))}`;
  }

  /** Registered with this quote key and encryption key; register (or update) if not. */
  async ensureRegistered(quoteUrl: string) {
    const me = await view<{ quote_key: string; enc_key: string } | null>(this.net, this.net.desk!, "maker", { account_id: this.account });
    const enc = toHexStr(this.wallet.id.encPublic);
    if (me && me.quote_key === this.quoteKey && me.enc_key === enc) return;
    await this.signer.call(this.net.desk!, "register_maker", { name: this.name, enc_key: enc, quote_url: quoteUrl, style: this.style, quote_key: this.quoteKey }, { gas: "30 Tgas", deposit: 10_000_000_000_000_000_000_000n });
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
    const give = priceAsk({ sellAmount, sellDecimals: sell.decimals, sellUsd, buyDecimals: buy.decimals, buyUsd, spreadBps: spread });
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
      const coin = ask.hedge?.coin ?? buy.hedgeCoin;
      const perps = await testnetPerps().catch(() => ({}) as Record<string, { asset: number; szDecimals: number }>);
      const perp = coin ? perps[coin] : undefined;
      const px = coin ? m[coin] : undefined;
      if (!coin || !perp || !px) return null;
      const size = Number(give) / 10 ** buy.decimals;
      q.hedge = { venue: "hyperliquid", coin, asset: perp.asset, isBuy: false, size: wireSize(size, perp.szDecimals), limitPx: wirePrice(px * 0.99, perp.szDecimals), deadlineMs: now + 10 * 60_000, testnet: true };
      // a tenth of the trade's value in USDC, held by the desk until the hedge leg is done
      const usdc = this.net.tokens.find((t) => t.symbol === "USDC")!;
      q.bond = BigInt(Math.max(1, Math.round(notionalUsd * 0.1))) * 10n ** BigInt(usdc.decimals);
    }
    const th = termsHash(termsOf(q, ask.kind));
    q.signature = toB64(ed25519.sign(consentBytes(q.rfqId, th, q.bond, q.expiresAtMs), this.quoteSecret));
    return q;
  }

  /** One round: answer new asks, settle new wins. */
  async step() {
    const enclave = await deskView.enclave(this.net);
    if (!enclave.enc_key) return;
    for (const r of await this.api.openRfqs(this.account)) {
      if (this.seen.has(r.rfqId)) continue;
      this.seen.add(r.rfqId);
      const ask = openJson<MakerAsk>(this.wallet.id.encSecret, Buffer.from(r.box, "base64"));
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
      const won = openJson<{ terms: AgreedTerms; trader_address: string }>(this.wallet.id.encSecret, Buffer.from(res.for_maker, "base64"));
      if (!won || won.terms.maker !== this.account || this.settling.has(res.dealId)) continue;
      this.stats.won++;
      this.settling.add(res.dealId);
      void settleAsMaker({ net: this.net, api: this.api, relayer: this.relayer, wallet: this.wallet, dealId: res.dealId, terms: won.terms, traderAddress: won.trader_address })
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

/** x402 indicative quotes: `GET /makers/:account/quote?sell=&amount=&buy=`, paid per quote (free on testnet). */
function x402Routes(a: ReturnType<typeof app>, makers: Maker[], net: HushdNetwork) {
  const free = settings.str("X402_FREE", net.id === "testnet" ? "1" : "0") === "1";
  a.get("/makers/:account/quote", async (c) => {
    const m = makers.find((x) => x.account === c.req.param("account"));
    if (!m) return c.json({ error: "No such maker here" }, 404);
    const sell = c.req.query("sell");
    const buy = c.req.query("buy");
    const amount = c.req.query("amount");
    if (!sell || !buy || !amount || !/^\d+$/.test(amount)) return c.json({ error: "sell, buy and amount (base units) are required" }, 400);
    const usdc = net.tokens.find((t) => t.symbol === "USDC")!;
    const accepts = [
      ...(free ? [{ scheme: "free", network: `near:${net.id}`, description: "Testnet: indicative quotes are free" }] : []),
      { scheme: "exact", network: `near:${net.id}`, asset: usdc.id, maxAmountRequired: "10000", payTo: m.account, resource: c.req.url, description: "One indicative quote (0.01 USDC)" },
    ];
    const header = c.req.header("x-payment");
    if (!header) return c.json({ x402Version: 2, error: "Payment required", accepts }, 402);
    let payment: { scheme?: string };
    try {
      payment = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { scheme?: string };
    } catch {
      return c.json({ x402Version: 2, error: "Unreadable payment header", accepts }, 402);
    }
    if (payment.scheme !== "free" || !free) return c.json({ x402Version: 2, error: "Only the free scheme is accepted on this network", accepts }, 402);
    const q = await m.quote({ v: 1, rfqId: 0, kind: "spot", sell: { token: sell, amount }, buyToken: buy, closesAtMs: Date.now() + 60_000 });
    if (!q) return c.json({ error: "No quote for this pair or size right now" }, 409);
    return c.json({ maker: m.account, style: m.style, give: { token: q.give.token, amount: q.give.amount.toString() }, take: { token: q.take.token, amount: q.take.amount.toString() }, indicative: true, validMs: 30_000 }, 200, { "x-payment-response": Buffer.from(JSON.stringify({ scheme: "free", success: true })).toString("base64") });
  });
}

export async function startMakers() {
  const net = network();
  await loadPoseidon();
  const relayer = new RelayerClient(settings.str("RELAYER_URL", "http://localhost:8787"));
  const api = new DeskApi(settings.str("API_URL", "http://localhost:8788"));
  const publicUrl = settings.str("MAKERS_PUBLIC_URL", "https://api.hushd.net");
  const makers: Maker[] = [];
  for (const [prefix, style] of [["MAKER_A", "fixed"], ["MAKER_B", "volatility"], ["MAKER_C", "inventory"]] as const) {
    const acc = account(prefix);
    const seed = process.env[`${prefix}_SEED`];
    const quoteKey = process.env[`${prefix}_QUOTE_KEY`];
    if (!acc || !seed || !quoteKey) continue;
    const name = settings.str(`${prefix}_NAME`, { fixed: "Steady", volatility: "Weather", inventory: "Ledger" }[style]);
    makers.push(new Maker(net, name, style, new Signer(net, acc), seed, quoteKey, api, relayer, settings.str("MAKERS_DATA_DIR", "./data/makers")));
  }
  if (makers.length === 0) throw new Error("No maker configured (MAKER_A_ACCOUNT, _PRIVATE_KEY, _SEED, _QUOTE_KEY)");
  for (const m of makers) {
    await m.wallet.restore();
    await m.ensureRegistered(`${publicUrl}/makers/${m.account}/quote`).catch((e) => console.error(`${m.name} register:`, (e as Error).message));
  }
  const a = app("makers", async () => ({ makers: makers.map((m) => ({ account: m.account, style: m.style, ...m.stats, balances: Object.fromEntries([...m.wallet.balances()].map(([k, v]) => [k, v.toString()])) })) }));
  x402Routes(a, makers, net);
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
