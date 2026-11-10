/**
 * The Hushd MCP tools. Read tools need nothing but the network (the hosted server at
 * https://hushd.net/mcp runs only these). Wallet tools act for one agent, inside its
 * spending limits, and prove everything in the agent's own process.
 */
import { formatUnits, parseUnits } from "@hushd/protocol";
import {
  awaitMatch,
  claimLink,
  CUSTODY,
  custodyView,
  checkMatchedTerms,
  decodeProof,
  deskView,
  encodeProof,
  isOwnLink,
  linkToken,
  linkUrl,
  makeNote,
  openRfq,
  packageRequest,
  parseLink,
  payAsLink,
  poolView,
  proveFunds,
  proveReceipt,
  proveVolume,
  sentLinks,
  settleAsTrader,
  takeBackLink,
  tokenInfo,
  verifyProof,
  x402Fetch,
  type HushdNetwork,
  type ProofKind,
} from "@hushd/sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Agent } from "./agent.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: (e as Error).message ?? String(e) }] });

async function run<T>(f: () => Promise<T>) {
  try {
    return json(await f());
  } catch (e) {
    return fail(e);
  }
}

function amountIn(net: HushdNetwork, token: string, amount: string) {
  const t = tokenInfo(net, token);
  const v = parseUnits(amount.replace(/,/g, ""), t.decimals);
  if (v <= 0n) throw new Error("The amount must be above zero");
  return { token: t.id, symbol: t.symbol, amount: v, decimals: t.decimals };
}

const human = (net: HushdNetwork, token: string, v: bigint) => `${formatUnits(v, tokenInfo(net, token).decimals)} ${tokenInfo(net, token).symbol}`;

const NO_NEAR = "This agent has no NEAR account: set HUSHD_POLICY_WALLET_KEY (an OutLayer policy wallet) or HUSHD_NEAR_ACCOUNT with HUSHD_NEAR_PRIVATE_KEY";
const TOKEN = z.string().describe("Token symbol (USDC, wNEAR, BTC) or NEP-141 account id");
const AMOUNT = z.string().regex(/^[\d,]+(\.\d+)?$/).describe("Amount in the token's units, e.g. \"25.5\"");

export function registerReadTools(server: McpServer, net: HushdNetwork, vkey: (kind: ProofKind) => Promise<unknown>) {
  server.registerTool(
    "hushd_status",
    { title: "Hushd status", description: "The private pool and the OTC desk on NEAR testnet: listed tokens and deposit limits, notes in the pool, deals matched and settled.", annotations: { readOnlyHint: true } },
    () => run(async () => ({ network: net.id, pool: net.pool, desk: net.desk, poolStats: await poolView.stats(net), assets: await poolView.assets(net), desk_stats: await deskView.stats(net) })),
  );
  server.registerTool(
    "hushd_makers",
    { title: "Makers", description: "Market makers taking requests now: name, pricing style, bond, deals and slashed amount. Paused accounts only with include_inactive.", inputSchema: { include_inactive: z.boolean().default(false) }, annotations: { readOnlyHint: true } },
    ({ include_inactive }) => run(async () => (await deskView.makers(net)).filter(([, m]) => include_inactive || m.active).map(([account, m]) => ({ account, ...m }))),
  );
  server.registerTool(
    "hushd_desk_deals",
    { title: "Desk deals", description: "Recent desk deals as the chain sees them: class, maker, state and receipt. Amounts and traders are private.", inputSchema: { limit: z.number().int().min(1).max(100).default(20) }, annotations: { readOnlyHint: true } },
    ({ limit }) => run(async () => deskView.deals(net, limit)),
  );
  server.registerTool(
    "hushd_deal",
    { title: "One deal", description: "One desk deal's public record and receipt.", inputSchema: { deal_id: z.number().int().min(0) }, annotations: { readOnlyHint: true } },
    ({ deal_id }) => run(async () => (await deskView.deal(net, deal_id)) ?? { error: `No deal #${deal_id}` }),
  );
  server.registerTool(
    "hushd_verify_proof",
    {
      title: "Check a proof",
      description: "Check a hushdproof1… string: the zero-knowledge proof, its reader and expiry, and the pool contract's own check against the chain.",
      inputSchema: { proof: z.string().startsWith("hushdproof1"), as_reader: z.string().optional().describe("The NEAR account doing the checking") },
      annotations: { readOnlyHint: true },
    },
    ({ proof, as_reader }) =>
      run(async () => {
        const p = decodeProof(proof);
        const v = await verifyProof(net, p, await vkey(p.kind), as_reader ? { asReader: as_reader } : {});
        return { holds: v.ok, shows: v.shows, problems: v.problems, reader: p.reader, expires: new Date(p.expiresAtMs).toISOString(), label_not_proven: p.label ?? null };
      }),
  );
}

export function registerWalletTools(server: McpServer, a: Agent, opts: { verifyBase: string; appUrl: string }) {
  const { net, wallet } = a;

  server.registerTool(
    "hushd_address",
    { title: "Receive address", description: "This agent's hushd1… address. Anyone can pay it privately; only this agent can spend what arrives.", annotations: { readOnlyHint: true } },
    () => run(async () => ({ address: a.id.address, near_account: a.near?.accountId ?? null })),
  );

  server.registerTool(
    "hushd_balance",
    { title: "Private balance", description: "Sync with the pool and the board, then list this agent's private balance per token.", annotations: { readOnlyHint: true } },
    () =>
      run(async () => {
        await wallet.sync();
        return { balances: net.tokens.map((t) => ({ token: t.symbol, amount: formatUnits(wallet.balances().get(t.id) ?? 0n, t.decimals) })), pending_notes: wallet.pending().length };
      }),
  );

  server.registerTool(
    "hushd_limits",
    { title: "Spending limits", description: "This agent's spending limits per payment and per day, and what it spent today.", annotations: { readOnlyHint: true } },
    () => run(async () => a.limits.describe()),
  );

  server.registerTool(
    "hushd_policy",
    {
      title: "Policy wallet",
      description: "Who controls this agent: its NEAR account (an OutLayer policy wallet, or its own key), the rules the TEE enforces before signing, whether the owner froze it, and Hushd's own limits on top.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => {
        const n = a.near;
        const hushd = { ...a.limits.describe(), enforced_by: "this server, before it proves or pays" };
        if (!n?.wallet) return { near_account: n?.accountId ?? null, signed_by: n ? "the agent's own key (no policy wallet)" : null, hushd_limits: hushd };
        const [p, chain] = await Promise.all([n.wallet.client.policy(), custodyView.policy(net, n.wallet.pubkey)]);
        return {
          near_account: n.accountId,
          signed_by: "OutLayer policy wallet: the key lives in a TEE and signs only what the owner's policy allows",
          owner: chain?.owner ?? null,
          frozen: chain?.frozen ?? p.frozen,
          tee_rules: p.rules,
          tee_usage: p.usage,
          hushd_limits: hushd,
          check_on_chain: `${net.explorer}/address/${CUSTODY[net.id].contract}`,
        };
      }),
  );

  server.registerTool(
    "hushd_faucet",
    { title: "Testnet tokens", description: "Testnet only: mint test tokens to this agent's NEAR account (then use hushd_shield).", inputSchema: { token: TOKEN } },
    ({ token }) =>
      run(async () => {
        if (net.id !== "testnet") throw new Error("There is no faucet on mainnet: send real tokens to this agent's NEAR account, then use hushd_shield");
        if (!a.near) throw new Error(NO_NEAR);
        const t = tokenInfo(net, token);
        const r = await a.relayer.faucet(a.near.accountId, t.id);
        return { token: t.symbol, to: a.near.accountId, tx: r.txHash };
      }),
  );

  server.registerTool(
    "hushd_shield",
    { title: "Add privately", description: "Move tokens from this agent's NEAR account into its private balance. The deposit is public; what happens after is not.", inputSchema: { token: TOKEN, amount: AMOUNT } },
    ({ token, amount }) =>
      run(async () => {
        if (!a.near) throw new Error(NO_NEAR);
        await a.assertNotFrozen();
        const x = amountIn(net, token, amount);
        const { call, selfPost } = wallet.shield(x.token, x.amount);
        await a.relayer.post(selfPost, "note");
        const tx = await a.near.call({ receiver: call.contract, method: call.method, args: call.args, gas: 120_000_000_000_000n, deposit: 1n });
        return { added: human(net, x.token, x.amount), tx, signed_by: a.near.kind === "policy-wallet" ? "policy wallet (OutLayer TEE)" : "agent key" };
      }),
  );

  server.registerTool(
    "hushd_send",
    { title: "Send privately", description: "Pay a hushd1… address from the private balance, inside the spending limits. Nobody else learns who paid whom or how much.", inputSchema: { to: z.string().startsWith("hushd1"), token: TOKEN, amount: AMOUNT, memo: z.string().max(120).optional() } },
    ({ to, token, amount, memo }) =>
      run(async () => {
        const x = amountIn(net, token, amount);
        await a.assertNotFrozen();
        a.limits.check(x.token, x.amount, to);
        const r = await wallet.send(to, x.token, x.amount, memo);
        a.limits.record(x.token, x.amount);
        return { sent: human(net, x.token, x.amount), to, tx: r.txHash };
      }),
  );

  server.registerTool(
    "hushd_pay_link",
    {
      title: "Pay as a link",
      description:
        "Pay someone who is not on Hushd yet: moves the amount from the private balance into a one-time note and returns a claim link. Whoever opens the link first claims it into their own private balance with a passkey or a NEAR wallet, and needs no gas. Inside the spending limits, like hushd_send. Anyone with the link can claim it, so share it privately; hushd_take_back_link takes back one nobody claimed.",
      inputSchema: { token: TOKEN, amount: AMOUNT },
    },
    ({ token, amount }) =>
      run(async () => {
        const x = amountIn(net, token, amount);
        await a.assertNotFrozen();
        a.limits.checkLink(x.token, x.amount);
        const r = await payAsLink(wallet, x.token, x.amount);
        a.limits.record(x.token, x.amount);
        return { link: linkUrl(opts.appUrl, r.link), amount: human(net, x.token, x.amount), tx: r.txHash, handling: "Anyone with this link can claim it. Share it privately." };
      }),
  );

  server.registerTool(
    "hushd_claim_link",
    {
      title: "Claim a link",
      description: "Claim a Hushd claim link (https://hushd.net/app/claim#…, or the code after the #) into this agent's private balance. The payment is checked in the pool first; the relayer sends the claim, so it needs no gas. Claiming a link this agent paid takes it back.",
      inputSchema: { link: z.string().min(8).max(2048).describe("The claim link, or the code after its #") },
    },
    ({ link: input }) =>
      run(async () => {
        const link = parseLink(input);
        linkToken(net, link);
        const own = isOwnLink(wallet, link);
        const r = own ? await takeBackLink(wallet, link, { artifacts: a.artifacts, relayer: a.relayer }) : await claimLink(link, { to: wallet, artifacts: a.artifacts, relayer: a.relayer });
        return { [own ? "taken_back" : "claimed"]: human(net, link.token, link.amount), tx: r.txHash };
      }),
  );

  server.registerTool(
    "hushd_my_links",
    {
      title: "My links",
      description: "Claim links this agent paid, newest first, read from the pool: waiting, claimed, taken back, sending (not in the pool yet) or not sent. A waiting link comes with its url, to share again; the index is what hushd_take_back_link takes.",
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () =>
        (await sentLinks(wallet)).map((l, index) => ({
          index,
          amount: human(net, l.link.token, l.link.amount),
          state: l.state,
          at: new Date(l.atMs).toISOString(),
          tx: l.txHash ?? null,
          ...(l.state === "waiting" ? { link: linkUrl(opts.appUrl, l.link) } : {}),
        })),
      ),
  );

  server.registerTool(
    "hushd_take_back_link",
    {
      title: "Take back a link",
      description: "Take back a link this agent paid that nobody has claimed yet (its index in hushd_my_links): the amount returns to the private balance, and the link stops working.",
      inputSchema: { index: z.number().int().min(0) },
    },
    ({ index }) =>
      run(async () => {
        const l = (await sentLinks(wallet))[index];
        if (!l) throw new Error(`No link #${index} from this agent (see hushd_my_links)`);
        if (l.state !== "waiting") throw new Error(`That link is ${l.state}, so there is nothing to take back`);
        const r = await takeBackLink(wallet, l.link, { artifacts: a.artifacts, relayer: a.relayer });
        return { taken_back: human(net, l.link.token, l.link.amount), tx: r.txHash };
      }),
  );

  server.registerTool(
    "hushd_cash_out",
    { title: "Cash out", description: "Pay out of the private balance to a NEAR account, inside the spending limits. The payout is public; where it came from is not.", inputSchema: { to_account: z.string().min(2), token: TOKEN, amount: AMOUNT } },
    ({ to_account, token, amount }) =>
      run(async () => {
        const x = amountIn(net, token, amount);
        await a.assertNotFrozen();
        a.limits.check(x.token, x.amount, to_account);
        const info = await a.relayer.info();
        const fee = (x.amount * BigInt(info.cashOutFeeBps)) / 10_000n;
        const r = await wallet.cashOut(to_account, x.token, x.amount, fee);
        a.limits.record(x.token, x.amount);
        return { paid_out: human(net, x.token, x.amount - fee), relayer_fee: human(net, x.token, fee), to: to_account, tx: r.txHash };
      }),
  );

  server.registerTool(
    "hushd_trade",
    {
      title: "Trade on the desk",
      description:
        "Ask the desk's makers for a price and settle privately. The request (with your limit) is sealed to the matcher enclave; makers see only the pair, side and size. Spot settles atomically in the pool; spot_hedge and carry add a bonded Hyperliquid hedge.",
      inputSchema: {
        kind: z.enum(["spot", "spot_hedge", "carry"]).default("spot"),
        sell_token: TOKEN,
        sell_amount: AMOUNT,
        buy_token: TOKEN,
        min_receive: AMOUNT.optional().describe("Least you accept of the buy token; sealed to the enclave"),
        window_seconds: z.number().int().min(10).max(300).default(45),
      },
    },
    ({ kind, sell_token, sell_amount, buy_token, min_receive, window_seconds }) =>
      run(async () => {
        const sell = amountIn(net, sell_token, sell_amount);
        const buy = tokenInfo(net, buy_token);
        await a.assertNotFrozen();
        a.limits.check(sell.token, sell.amount);
        await wallet.sync();
        const draft = { kind, sell: { token: sell.token, amount: sell.amount }, buy: { token: buy.id, minAmount: min_receive ? parseUnits(min_receive, buy.decimals) : 0n } };
        const { request, ask, refundBlinding } = packageRequest(a.id, net, draft);
        const opened = await openRfq({ net, api: a.api, relayer: a.relayer, request, ask, windowMs: window_seconds * 1000 });
        const match = await awaitMatch(a.api, a.id, opened.rfqId, window_seconds * 1000 + 120_000);
        checkMatchedTerms(match.terms, draft);
        if (BigInt(match.terms.bond) > 0n && net.bondToken) await wallet.expect(makeNote(a.id.pk, net.bondToken, BigInt(match.terms.bond), refundBlinding), { memo: "Bond paid to you", dealId: String(match.dealId) });
        const record = { dealId: match.dealId, rfqId: opened.rfqId, role: "trader" as const, kind, maker: match.terms.maker, class: match.terms.class, gave: match.terms.traderGives, got: match.terms.makerGives, bond: match.terms.bond, refundBlinding: refundBlinding.toString(), atMs: Date.now() };
        await wallet.rememberDeal(record);
        await settleAsTrader({ net, api: a.api, wallet, dealId: match.dealId, terms: match.terms, makerAddress: match.maker_address, refundBlinding });
        await wallet.rememberDeal({ ...record, settledAtMs: Date.now() });
        a.limits.record(sell.token, sell.amount);
        return {
          deal_id: match.dealId,
          maker: match.terms.maker,
          gave: human(net, match.terms.traderGives.token, BigInt(match.terms.traderGives.amount)),
          got: human(net, match.terms.makerGives.token, BigInt(match.terms.makerGives.amount)),
          settlement: match.terms.class,
          hedge: match.terms.hedge ?? null,
        };
      }),
  );

  server.registerTool(
    "hushd_my_deals",
    { title: "My deals", description: "Desk deals this agent took part in, with the private terms only it can read.", annotations: { readOnlyHint: true } },
    () => run(async () => wallet.deals().map((d) => ({ deal_id: d.dealId, kind: d.kind, maker: d.maker, gave: human(net, d.gave.token, BigInt(d.gave.amount)), got: human(net, d.got.token, BigInt(d.got.amount)), settled: Boolean(d.settledAtMs) }))),
  );

  server.registerTool(
    "hushd_prove",
    {
      title: "Prove to one reader",
      description:
        "Make a proof for one named NEAR account that expires: an exact payment, a payment of at least an amount, funds held above a threshold, or total desk volume in a token. Returns the proof and a link to check it.",
      inputSchema: {
        what: z.enum(["payment", "payment_at_least", "funds", "volume"]),
        reader: z.string().min(2).max(64).describe("NEAR account that may read the proof, e.g. auditor.testnet"),
        days: z.number().int().min(1).max(90).default(7),
        deal_id: z.number().int().optional().describe("payment: which deal leg (default: the latest payment)"),
        payment_index: z.number().int().min(0).optional().describe("payment: index in hushd_my_payments order"),
        at_least: AMOUNT.optional().describe("payment_at_least: the amount to show it reached"),
        token: TOKEN.optional().describe("funds and volume: which token"),
        threshold: AMOUNT.optional().describe("funds: the amount held at least"),
      },
    },
    (i) =>
      run(async () => {
        const scope = { net, reader: i.reader, expiresAtMs: Date.now() + i.days * 86_400_000 };
        const payments = wallet.payments();
        let proof;
        if (i.what === "payment" || i.what === "payment_at_least") {
          const p = i.deal_id !== undefined ? payments.find((x) => x.dealId === String(i.deal_id)) : payments[i.payment_index ?? 0];
          if (!p) throw new Error("No such payment from this agent");
          const min = i.what === "payment_at_least" ? amountIn(net, p.token, i.at_least ?? "").amount : undefined;
          proof = await proveReceipt(a.artifacts, a.id, scope, p.made, p.paidWith, { revealAmount: i.what === "payment", ...(min !== undefined ? { minAmount: min } : {}) });
        } else if (i.what === "funds") {
          const x = amountIn(net, i.token ?? "", i.threshold ?? "");
          await wallet.sync();
          const notes = wallet.spendable(x.token).sort((m, n) => (m.amount < n.amount ? 1 : -1)).slice(0, 4);
          proof = await proveFunds(a.artifacts, a.id, scope, wallet.merkleTree, notes, x.amount);
        } else {
          const t = tokenInfo(net, i.token ?? "");
          const legs = payments.filter((p) => p.kind === "deal" && p.token === t.id).slice(0, 16);
          if (legs.length === 0) throw new Error(`No desk deals in ${t.symbol} yet`);
          proof = await proveVolume(a.artifacts, a.id, scope, legs.map((p) => ({ made: p.made, paidWith: p.paidWith })));
        }
        const s = encodeProof(proof);
        return { reader: i.reader, expires: new Date(scope.expiresAtMs).toISOString(), proof: s, check_at: `${opts.verifyBase}#p=${s}` };
      }),
  );

  server.registerTool(
    "hushd_my_payments",
    { title: "My payments", description: "Payments this agent made (private sends and deal legs), newest first; their index is what hushd_prove takes.", annotations: { readOnlyHint: true } },
    () => run(async () => wallet.payments().map((p, index) => ({ index, kind: p.kind, amount: human(net, p.token, p.made.amount), deal_id: p.dealId ?? null, to: p.to ?? null, tx: p.txHash ?? null, at: new Date(p.atMs).toISOString() }))),
  );

  server.registerTool(
    "hushd_pay_x402",
    {
      title: "Pay an x402 resource privately",
      description: "Fetch a URL; if it answers 402 asking for a private Hushd payment, pay it from the private balance (inside the limits) and fetch again. Returns the response body.",
      inputSchema: { url: z.string().url(), method: z.enum(["GET", "POST"]).default("GET"), body: z.string().max(20_000).optional() },
    },
    ({ url, method, body }) =>
      run(async () => {
        await a.assertNotFrozen();
        await wallet.sync();
        const { response, paid } = await x402Fetch(wallet, url, { method, ...(body ? { body, headers: { "content-type": "application/json" } } : {}) }, {
          maxAmount: (token) => a.limits.maxFor(tokenInfo(net, token).id),
          onPaid: (p) => a.limits.record(tokenInfo(net, p.token).id, p.amount),
        });
        const text = await response.text();
        return { status: response.status, paid: paid ? { amount: human(net, paid.token, paid.amount), tx: paid.txHash } : null, body: text.slice(0, 20_000) };
      }),
  );
}
