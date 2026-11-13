/**
 * The matcher client. When an RFQ's sealed window closes it sends the sealed batch
 * (the request and every sealed quote) to the matcher enclave on OutLayer and submits
 * the enclave-signed match to the desk. It cannot read the request, the quotes or the
 * result's sealed terms; it only carries them.
 */
import { spawn } from "node:child_process";
import { network, account, settings } from "./config.js";
import { Signer } from "./chain.js";
import { Db } from "./db.js";
import { app, listen } from "./http.js";
import { CUSTODY, type HushdNetwork } from "@hushd/sdk";

export interface EnclaveCall {
  (input: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** OutLayer's HTTPS API: POST {api}/call/{owner}/{project}. */
export function outlayerHttps(net: HushdNetwork): EnclaveCall {
  const api = settings.str("OUTLAYER_API", CUSTODY[net.id].api);
  const project = settings.str("OUTLAYER_PROJECT", net.id === "mainnet" ? "hushd.near/matcher" : "hushd.testnet/matcher");
  const key = settings.str("OUTLAYER_KEY", "");
  return async (input) => {
    if (!key) throw new Error("OUTLAYER_KEY is not set (a payment key or a wk_ API key)");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key.startsWith("wk_")) headers.authorization = `Bearer ${key}`;
    else headers["x-payment-key"] = key;
    // the matcher's key is a protected secret of the project owner, locked to the deployed build
    const secretsRef = { profile: "default", account_id: settings.str("OUTLAYER_SECRETS_OWNER", project.split("/")[0]!) };
    // a busy OutLayer worker has taken more than 120 s; traders wait MATCH_WAIT_MS past the window
    const res = await fetch(`${api}/call/${project}`, { method: "POST", headers, body: JSON.stringify({ input, async: false, secrets_ref: secretsRef }), signal: AbortSignal.timeout(240_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`OutLayer answered ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { output?: unknown; result?: unknown; error?: string; status?: string; attestation_url?: string };
    if (body.error) throw new Error(`The matcher failed in OutLayer: ${body.error}`);
    // The module's stdout comes back as `output` (a string or parsed JSON) or `result`.
    const out = body.output ?? body.result ?? body;
    const parsed = (typeof out === "string" ? JSON.parse(out) : out) as Record<string, unknown>;
    return body.attestation_url ? { ...parsed, attestation_url: body.attestation_url } : parsed;
  };
}

/**
 * The same matcher code run as a local process, for a local sandbox node only: there is
 * no TEE, so whoever runs it sees the requests and quotes. MATCHER_LOCAL_BIN is a native
 * build of `matcher/` and MATCHER_LOCAL_KEY its 32-byte hex seed.
 */
export function localEnclave(bin: string, seedHex: string): EnclaveCall {
  return (input) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, [], { env: { PROTECTED_MATCHER_KEY: seedHex }, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (b: Buffer) => (out += b.toString()));
      child.stderr.on("data", (b: Buffer) => (err += b.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`the local matcher exited ${code}: ${err.slice(0, 300)}`));
        try {
          // like OutLayer, hand back the module's own answer (a failed match is `matched: false` with its reason)
          resolve(JSON.parse(out) as Record<string, unknown>);
        } catch {
          reject(new Error(`the local matcher printed no JSON: ${out.slice(0, 200)}`));
        }
      });
      child.stdin.end(JSON.stringify(input));
    });
}

export class Matcher {
  constructor(readonly net: HushdNetwork, readonly db: Db, readonly signer: Signer, readonly enclave: EnclaveCall, readonly now = () => Date.now()) {}

  /** Match every RFQ whose window has closed. */
  async step(): Promise<number> {
    const due = await this.db.q<{ rfq_id: string; rfq_box: string; commitment: string }>(
      "select rfq_id, rfq_box, commitment from rfqs where status = 'open' and closes_at_ms <= $1 order by rfq_id limit 10",
      [this.now()],
    );
    for (const r of due.rows) await this.matchOne(Number(r.rfq_id), r.rfq_box, r.commitment);
    return due.rows.length;
  }

  async matchOne(rfqId: number, rfqBox: string, commitment: string) {
    await this.db.q("update rfqs set status = 'matching' where rfq_id = $1", [rfqId]);
    const quotes = await this.db.q<{ box: string }>("select box from quotes where rfq_id = $1 order by at_ms", [rfqId]);
    try {
      if (quotes.rows.length === 0) {
        await this.finish(rfqId, "no_quotes", null, { matched: false, reason: "No maker quoted in time" }, null);
        return;
      }
      const batch = Buffer.from(JSON.stringify({ rfq: rfqBox, quotes: quotes.rows.map((q) => q.box) })).toString("base64");
      // makers sign for one desk and the enclave signs the match for it: name it
      const out = await this.enclave({ cmd: "match", desk: this.net.desk, rfq_id: String(rfqId), rfq_commitment: commitment, batch });
      if (out.matched !== true) {
        await this.finish(rfqId, "no_match", null, { matched: false, reason: out.reason ?? out.error ?? "No quote inside the limit" }, null);
        return;
      }
      const r = await this.signer.call(this.net.desk!, "submit_match", { result: out.match, signature: out.signature }, { gas: "50 Tgas", deposit: 10_000_000_000_000_000_000_000n });
      const dealId = Number(r.result);
      await this.finish(rfqId, "matched", dealId, { matched: true, match: out.match, for_trader: out.for_trader, for_maker: out.for_maker, quotes: out.quotes, refused: out.refused, attestation_url: out.attestation_url ?? null }, r.txHash);
    } catch (e) {
      await this.finish(rfqId, "failed", null, { matched: false, reason: (e as Error).message }, null);
    }
  }

  private async finish(rfqId: number, status: string, dealId: number | null, result: unknown, txHash: string | null) {
    await this.db.q("update rfqs set status = $2 where rfq_id = $1", [rfqId, status]);
    await this.db.q(
      "insert into results (rfq_id, deal_id, result, tx_hash, at_ms) values ($1,$2,$3,$4,$5) on conflict (rfq_id) do update set deal_id = excluded.deal_id, result = excluded.result, tx_hash = excluded.tx_hash",
      [rfqId, dealId, JSON.stringify(result), txHash, this.now()],
    );
  }
}

export async function startMatcher() {
  const net = network();
  const acc = account("MATCHER");
  if (!acc) throw new Error("MATCHER_ACCOUNT and MATCHER_PRIVATE_KEY are required");
  const db = new Db(settings.databaseUrl());
  await db.migrate();
  const local = settings.str("MATCHER_LOCAL_BIN", "");
  if (local && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(net.rpc[0]!)) throw new Error("MATCHER_LOCAL_BIN runs the matcher outside a TEE: only against a local sandbox node");
  const m = new Matcher(net, db, new Signer(net, acc), local ? localEnclave(local, settings.str("MATCHER_LOCAL_KEY", "")) : outlayerHttps(net));
  listen(app("matcher", async () => ({ account: acc.accountId })), settings.port("matcher", 8790), "matcher");
  for (;;) {
    await m.step().catch((e) => console.error("matcher:", (e as Error).message));
    await new Promise((r) => setTimeout(r, 1_500));
  }
}
