/**
 * The Hushd read API and the desk's sealed message rooms.
 *
 * - Reads for the app and transparency views: chain views plus the indexer's events.
 * - RFQ intake: the trader posts the sealed request (and the maker-visible ask sealed
 *   to each maker); makers post quotes sealed to the enclave. The API checks the
 *   request is the one committed on chain but can open none of it.
 * - Deal rooms: the two sides of a matched deal swap sealed messages (their planned
 *   outputs, the opening of the note each makes for the other, their proven legs).
 * - NEAR Intents: dry 1Click quotes for deposits from and cash-outs to other chains, and
 *   the mainnet trades between our agents (intents.ts).
 * - Market: Hyperliquid mainnet mids and candles for the trading screen (market.ts).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { boardView, poolView, view, type HushdNetwork } from "@hushd/sdk";
import { network, settings } from "./config.js";
import { Db } from "./db.js";
import { app, BadRequest, listen, rateLimit } from "./http.js";
import { intakeRoutes } from "./intake.js";
import { intentsRoutes, type IntentsDeps } from "./intents.js";
import { marketRoutes, type MarketDeps } from "./market.js";

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const isB64 = (s: unknown, max: number): s is string => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const isKeyHex = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s);

export interface DeskRfq {
  commitment: string;
  closes_at_ms: string;
  deal_id: string | null;
}

/** Which rate budget a request path draws on (see `buildApi`). */
export function limitFor<T>(path: string, limits: { market: T; makers: T; flow: T; rest: T }): T {
  if (path.startsWith("/v1/market/")) return limits.market;
  if (path === "/v1/rfq/open" || /^\/v1\/rfq\/\d+\/quotes$/.test(path)) return limits.makers;
  if (/^\/v1\/(rfq(\/|$)|deals\/\d+\/messages)/.test(path)) return limits.flow;
  return limits.rest;
}

export function buildApi(net: HushdNetwork, db: Db, now = () => Date.now(), intents: IntentsDeps = {}, market: MarketDeps = {}) {
  const desk = () => {
    if (!net.desk) throw new BadRequest(`no desk on ${net.id}`);
    return net.desk;
  };
  let makersCache: { at: number; makers: Map<string, unknown> } | null = null;
  const makers = async () => {
    if (!makersCache || now() - makersCache.at > 30_000) {
      const list = await view<[string, unknown][]>(net, desk(), "makers");
      makersCache = { at: now(), makers: new Map(list) };
    }
    return makersCache.makers;
  };

  const a = app("api", async () => {
    const r = await db.q<{ height: string }>("select height from cursor where name = 'indexer'");
    return { indexerCursor: r.rows[0] ? Number(r.rows[0].height) : null };
  });
  // separate budgets per client, so background reads never use up what a trade in progress
  // needs: cached market data, the makers' own routes (open requests, quotes), the trade flow
  // (requests, matches, the per-deal mailbox), and the rest
  const limits = {
    market: rateLimit(settings.num("API_MARKET_PER_MINUTE", 600)),
    makers: rateLimit(settings.num("API_MAKERS_PER_MINUTE", 600)),
    flow: rateLimit(settings.num("API_FLOW_PER_MINUTE", 900)),
    rest: rateLimit(settings.num("API_PER_MINUTE", 240)),
  };
  a.use("/v1/*", (c, next) => limitFor(c.req.path, limits)(c, next));

  a.get("/v1/stats", async (c) => {
    const [pool, deskStats, assets, posts] = await Promise.all([
      net.pool ? poolView.stats(net) : null,
      net.desk ? view(net, net.desk, "stats") : null,
      net.pool ? poolView.assets(net) : [],
      net.board ? boardView.count(net) : 0,
    ]);
    return c.json({ network: net.id, pool, desk: deskStats, assets, boardPosts: posts });
  });

  a.get("/v1/makers", async (c) => c.json([...(await makers()).entries()].map(([account, m]) => ({ account, ...(m as object) }))));

  a.get("/v1/deals", async (c) => c.json(await view(net, desk(), "deals", { from_index: null, limit: Math.min(Number(c.req.query("limit") ?? 20), 100) })));

  a.get("/v1/deals/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^\d+$/.test(id)) throw new BadRequest("deal id");
    const deal = await view(net, desk(), "deal", { deal_id: id });
    const events = await db.q("select event, data, tx_hash, block_height, block_ms from events where contract = $1 and data->>'deal_id' = $2 order by block_height, log_index", [desk(), id]);
    return c.json({ deal, events: events.rows });
  });

  a.get("/v1/events", async (c) => {
    const contract = c.req.query("contract");
    const event = c.req.query("event");
    const from = Number(c.req.query("from") ?? 0);
    const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
    const r = await db.q(
      `select contract, event, data, tx_hash, block_height, block_ms from events
       where ($1::text is null or contract = $1) and ($2::text is null or event = $2) and block_height >= $3
       order by block_height desc, log_index desc limit $4`,
      [contract ?? null, event ?? null, from, limit],
    );
    return c.json(r.rows);
  });

  intakeRoutes(a);
  intentsRoutes(a, { now, ...intents });
  marketRoutes(a, net, { now, ...market });

  // ---------- RFQs ----------

  a.post("/v1/rfq", async (c) => {
    const b = await c.req.json<{ rfqId: number; rfqBox: string; makerBoxes: Record<string, string> }>();
    if (!Number.isInteger(b.rfqId) || b.rfqId < 0) throw new BadRequest("rfqId");
    if (!isB64(b.rfqBox, 16_000)) throw new BadRequest("rfqBox is base64");
    const boxes = Object.entries(b.makerBoxes ?? {});
    if (boxes.length === 0 || boxes.length > 32 || !boxes.every(([m, x]) => typeof m === "string" && isB64(x, 4_000))) throw new BadRequest("makerBoxes");
    const onChain = await view<DeskRfq | null>(net, desk(), "rfq", { rfq_id: String(b.rfqId) });
    if (!onChain) throw new BadRequest("No such RFQ on the desk");
    const commitment = hex(sha256(Buffer.from(b.rfqBox, "base64")));
    if (onChain.commitment !== commitment) throw new BadRequest("This request is not the one committed on chain");
    await db.q(
      `insert into rfqs (rfq_id, rfq_box, commitment, maker_boxes, closes_at_ms, created_ms) values ($1,$2,$3,$4,$5,$6) on conflict (rfq_id) do nothing`,
      [b.rfqId, b.rfqBox, commitment, JSON.stringify(b.makerBoxes), Number(onChain.closes_at_ms), now()],
    );
    return c.json({ ok: true, closesAtMs: Number(onChain.closes_at_ms) });
  });

  a.get("/v1/rfq/open", async (c) => {
    const maker = c.req.query("maker");
    if (!maker) throw new BadRequest("maker");
    const r = await db.q<{ rfq_id: string; box: string | null; closes_at_ms: string }>(
      "select rfq_id, maker_boxes->>$1 as box, closes_at_ms from rfqs where status = 'open' and closes_at_ms > $2 order by rfq_id",
      [maker, now()],
    );
    return c.json(r.rows.filter((x) => x.box).map((x) => ({ rfqId: Number(x.rfq_id), box: x.box, closesAtMs: Number(x.closes_at_ms) })));
  });

  a.post("/v1/rfq/:id/quotes", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await c.req.json<{ maker: string; box: string }>();
    if (!isB64(b.box, 8_000)) throw new BadRequest("box is base64");
    if (!(await makers()).has(b.maker)) throw new BadRequest("Not a registered maker");
    const r = await db.q<{ closes_at_ms: string; status: string }>("select closes_at_ms, status from rfqs where rfq_id = $1", [id]);
    const rfq = r.rows[0];
    if (!rfq || rfq.status !== "open" || Number(rfq.closes_at_ms) <= now()) throw new BadRequest("This RFQ is closed");
    await db.q("insert into quotes (rfq_id, maker, box, at_ms) values ($1,$2,$3,$4) on conflict (rfq_id, maker) do update set box = excluded.box, at_ms = excluded.at_ms", [id, b.maker, b.box, now()]);
    return c.json({ ok: true });
  });

  a.get("/v1/rfq/:id/result", async (c) => {
    const id = Number(c.req.param("id"));
    const rfq = await db.q<{ status: string; closes_at_ms: string }>("select status, closes_at_ms from rfqs where rfq_id = $1", [id]);
    if (!rfq.rows[0]) return c.json({ status: "unknown" }, 404);
    const q = await db.q<{ n: string }>("select count(*) as n from quotes where rfq_id = $1", [id]);
    const res = await db.q<{ deal_id: string | null; result: Record<string, unknown>; tx_hash: string | null }>("select deal_id, result, tx_hash from results where rfq_id = $1", [id]);
    const row = res.rows[0];
    return c.json({
      status: rfq.rows[0].status,
      closesAtMs: Number(rfq.rows[0].closes_at_ms),
      quotes: Number(q.rows[0]!.n),
      ...(row ? { dealId: row.deal_id === null ? null : Number(row.deal_id), txHash: row.tx_hash, ...row.result } : {}),
    });
  });

  // ---------- deal rooms ----------

  a.post("/v1/deals/:id/messages", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await c.req.json<{ to: string; box: string }>();
    if (!isKeyHex(b.to)) throw new BadRequest("to is the recipient's X25519 key, 0x hex");
    if (!isB64(b.box, 120_000)) throw new BadRequest("box is base64");
    const n = await db.q<{ n: string }>("select count(*) as n from messages where deal_id = $1", [id]);
    if (Number(n.rows[0]!.n) > 64) throw new BadRequest("This deal room is full");
    const r = await db.q<{ id: string }>("insert into messages (deal_id, recipient, box, at_ms) values ($1,$2,$3,$4) returning id", [id, b.to, b.box, now()]);
    return c.json({ id: Number(r.rows[0]!.id) });
  });

  a.get("/v1/deals/:id/messages", async (c) => {
    const id = Number(c.req.param("id"));
    const to = c.req.query("to");
    if (!isKeyHex(to)) throw new BadRequest("to");
    const after = Number(c.req.query("after") ?? 0);
    const r = await db.q<{ id: string; box: string }>("select id, box from messages where deal_id = $1 and recipient = $2 and id > $3 order by id", [id, to, after]);
    return c.json(r.rows.map((x) => ({ id: Number(x.id), box: x.box })));
  });

  // ---------- status ----------

  a.get("/v1/status", async (c) => {
    const accounts = settings.str("SERVICE_ACCOUNTS", "").split(",").filter(Boolean);
    const treasury = settings.str("TREASURY_ACCOUNT", "");
    const low = BigInt(settings.str("TREASURY_LOW_YOCTO", "5000000000000000000000000"));
    const balances = await Promise.all(
      [...new Set([treasury, ...accounts].filter(Boolean))].map(async (acc) => {
        const { accountBalance } = await import("@hushd/sdk");
        const b = await accountBalance(net, acc).catch(() => null);
        return { account: acc, balance: b?.toString() ?? null };
      }),
    );
    const t = balances.find((b) => b.account === treasury);
    const relayerUrl = settings.str("RELAYER_URL", "http://localhost:8787");
    const lanes = await fetch(`${relayerUrl}/v1/relay/lanes`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.json()).catch(() => null);
    return c.json({ network: net.id, balances, treasury: treasury || null, treasuryLow: t?.balance ? BigInt(t.balance) < low : null, lanes });
  });

  return a;
}

export async function startApi() {
  const net = network();
  const db = new Db(settings.databaseUrl());
  await db.migrate();
  listen(buildApi(net, db), settings.port("api", 8788), "api");
}
