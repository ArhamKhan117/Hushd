import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { encryptForModel } from "../../packages/sdk/src/intake";
import { allEndpoints, forBrowser, TESTNET } from "../../packages/sdk/src/network";

export const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Answer some of the desk's view calls from `views` (by method name), on every RPC endpoint
 * the browser may ask; every other call goes to the chain as usual.
 */
export async function stubDeskViews(page: Page, views: Record<string, unknown>) {
  const endpoints = allEndpoints(forBrowser(TESTNET));
  await page.route(
    (url) => endpoints.some((e) => url.href.startsWith(e)),
    async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const body = req.postDataJSON() as { params?: { account_id?: string; method_name?: string } } | null;
      const name = body?.params?.method_name;
      if (body?.params?.account_id !== TESTNET.desk || !name || !(name in views)) return route.fallback();
      return route.fulfill({ json: { jsonrpc: "2.0", id: "hushd", result: { result: [...Buffer.from(JSON.stringify(views[name]))], logs: [] } }, headers: CORS });
    },
  );
}

/** A passkey account on a virtual authenticator, with the relayer's activation stubbed: nothing goes on chain. */
export async function signInWithPasskey(page: Page, context: BrowserContext) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await page.route("**/v1/relay/activate", (r) => (r.request().method() === "OPTIONS" ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill({ json: { activated: false }, headers: CORS })));
  const create = page.getByRole("button", { name: "Create a passkey" });
  // a click before hydration is lost: press until the panel goes
  await expect(async () => {
    await create.click({ timeout: 2_000 });
    await expect(create).toBeHidden({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

/** The attestation a stand-in model hands out. */
export function standInAttestation(modelPub: string) {
  return { model: "stand-in/model", signing_public_key: modelPub, signing_address: modelPub, tcb_status: "UpToDate", gpu_evidence: "verified", verified_at_ms: Date.UTC(2026, 10, 10, 9, 30), enabled: true, verify_url: "https://cloud.near.ai/verify" };
}

/** NEAR AI intake answered by a stand-in model with its own key, signing every answer with it. */
export async function stubIntake(page: Page, attestation?: (modelPub: string) => Record<string, unknown>) {
  const model = ed25519.utils.randomSecretKey();
  const modelPub = hex(ed25519.getPublicKey(model));
  const att = (attestation ?? standInAttestation)(modelPub);
  await page.route("**/v1/intake/attestation", (route) => route.fulfill({ json: att, headers: CORS }));
  await page.route("**/v1/intake/chat", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const b = JSON.parse(route.request().postData() ?? "{}") as { body: string; clientPub: string };
    const draft = { kind: "spot", sell: { symbol: "USDC", amount: "200" }, buy: { symbol: "BTC" }, min_receive: null, limit_price: null, hedge: false, window_minutes: 1, notes: "Sell 200 USDC for BTC." };
    const response = JSON.stringify({ id: "stand-in-1", choices: [{ message: { content: encryptForModel(JSON.stringify(draft), b.clientPub) } }] });
    const text = `stand-in/model:${hex(sha256(new TextEncoder().encode(b.body)))}:${hex(sha256(new TextEncoder().encode(response)))}`;
    const signature = { text, signature: hex(ed25519.sign(new TextEncoder().encode(text), model)), signing_address: modelPub, signature_kind: "provider_tee" };
    await route.fulfill({ json: { response, serverVerified: true, signature }, headers: CORS });
  });
  return { modelPub };
}

/**
 * Three makers and their deals of the past hours: Steady settles all six, Lapser lets three
 * of six lapse (skipped), Fresh lapsed its only deal (too few to judge, still asked).
 */
export function deskWithRecords() {
  const now = Date.now();
  const maker = (name: string, bond: string) => ({ name, enc_key: `0x${"11".repeat(32)}`, quote_url: "", style: "fixed", quote_key: "ed25519:x", bond, locked: "0", deals: 6, slashed: "0", active: true });
  const ends: [string, "settled" | "failed"][] = [
    ["steady.testnet", "settled"], ["lapser.testnet", "failed"], ["steady.testnet", "settled"], ["lapser.testnet", "settled"], ["fresh.testnet", "failed"], ["steady.testnet", "settled"],
    ["lapser.testnet", "failed"], ["steady.testnet", "settled"], ["lapser.testnet", "settled"], ["steady.testnet", "settled"], ["lapser.testnet", "failed"], ["steady.testnet", "settled"], ["lapser.testnet", "settled"],
  ];
  const deals = ends.map(([m, outcome], i) => {
    const id = 912 - i;
    const matched = now - (i + 1) * 600_000;
    return {
      id: String(id), rfq_id: String(id), maker: m, terms_hash: "0x00", class: "atomic_pool", matched_at_ms: String(matched), expires_at_ms: String(matched + 240_000),
      bond: "0", hedge: null, status: "closed", settle_attempts: outcome === "settled" ? 1 : 0, hedge_orders: 0, hedge_attempts: 0, bond_released: true, slash_held: "0", attested_by: "enclave_signature",
      receipt: { outcome, evidence: outcome === "failed" ? [{ kind: "expired", reference: `not settled by ${matched + 240_000}` }] : [], recorded_at_ms: String(matched + 30_000) },
    };
  });
  const project = "hushd.testnet/matcher@7521d46a6a79a26f31fe94d70f4c84b9ba6bf825090ec8f18b9ecdb14bf363ae";
  return {
    makers: [["steady.testnet", maker("Steady", "20000000000")], ["lapser.testnet", maker("Lapser", "40000000000")], ["fresh.testnet", maker("Fresh", "20000000000")]],
    deals,
    // the rest of what the pages read of the desk, so a rate-limited RPC cannot fail the test
    stats: { rfqs: 15, deals: 13, settled: 9, recovered: 0, failed: 4, unresolved: 0, slashed: "0" },
    enclave: { sign_key: `0x${"ab".repeat(32)}`, enc_key: `0x${"cd".repeat(32)}`, project },
    config: {
      owner: "hushd.testnet", pool: "pool.hushd.testnet", bond_token: "usdc.hushd.testnet", outlayer: "outlayer.testnet", matcher_project: project, secrets_owner: "hushd.testnet",
      mpc: "v1.signer-prod.testnet", keeper: "keeper.hushd.testnet", outlayer_fee: "100000000000000000000000", min_bond: "1000000000", config_timelock_ns: "86400000000000",
    },
  };
}
