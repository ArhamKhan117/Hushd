import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expect, test, type Page } from "@playwright/test";
import { encryptForModel } from "../../packages/sdk/src/intake";
import { expectBoughtInBalance, moveTxOf } from "./balance";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * NEAR AI intake as the browser meets it: the live model when the API's attestation checks
 * out, and otherwise a stand-in model with its own key, so the browser's own checks still run.
 * `signer` picks who signs the stand-in's answers: the attested key, or another one.
 */
async function intakeRoutes(page: Page) {
  const model = ed25519.utils.randomSecretKey();
  const other = ed25519.utils.randomSecretKey();
  const modelPub = hex(ed25519.getPublicKey(model));
  let answered = () => {};
  // the page asks for the attestation as it loads: whether the model is live is known only once that answer is in
  const attested = new Promise<void>((done) => (answered = done));
  const state = { live: false, signer: "attested" as "attested" | "other", attested };
  await page.route("**/v1/intake/attestation", async (route) => {
    // HUSHD_E2E_INTAKE=stand-in skips the live model (when NEAR AI says it is unavailable)
    const real = process.env.HUSHD_E2E_INTAKE === "stand-in" ? null : await route.fetch().catch(() => null);
    const att = real ? ((await real.json().catch(() => ({}))) as { enabled?: boolean; signing_public_key?: string }) : {};
    state.live = Boolean(att.enabled && att.signing_public_key);
    answered();
    if (state.live && real) return route.fulfill({ response: real });
    await route.fulfill({ json: { model: "stand-in/model", signing_public_key: modelPub, signing_address: modelPub, tcb_status: "UpToDate", gpu_evidence: "verified", verified_at_ms: Date.now(), enabled: true, verify_url: "https://cloud.near.ai/verify" }, headers: CORS });
  });
  await page.route("**/v1/intake/chat", async (route) => {
    if (state.live) return route.continue();
    const b = JSON.parse(route.request().postData() ?? "{}") as { body: string; clientPub: string };
    const draft = { kind: "spot", sell: { symbol: "USDC", amount: "200" }, buy: { symbol: "BTC" }, min_receive: null, limit_price: null, hedge: false, window_minutes: 1, notes: "Sell 200 USDC for BTC." };
    const response = JSON.stringify({ id: "stand-in-1", choices: [{ message: { content: encryptForModel(JSON.stringify(draft), b.clientPub) } }] });
    const text = `stand-in/model:${hex(sha256(new TextEncoder().encode(b.body)))}:${hex(sha256(new TextEncoder().encode(response)))}`;
    const key = state.signer === "attested" ? model : other;
    const signature = { text, signature: hex(ed25519.sign(new TextEncoder().encode(text), key)), signing_address: hex(ed25519.getPublicKey(key)), signature_kind: "provider_tee" };
    await route.fulfill({ json: { response, serverVerified: true, signature }, headers: CORS });
  });
  return state;
}

/**
 * The whole product on NEAR testnet, as a new user: a passkey account, test tokens,
 * a private deposit, a desk deal settled privately, its deal page, and a proof for a
 * named reader checked on /verify. Needs the live contracts and services.
 */
test.skip(!process.env.HUSHD_E2E_TESTNET, "set HUSHD_E2E_TESTNET=1 to run against testnet");
test.describe.configure({ mode: "serial", timeout: 15 * 60_000 });

test("a new passkey user trades privately and proves it", async ({ page, context, browserName }) => {
  test.skip(browserName !== "chromium", "the virtual authenticator is Chromium only");
  await context.addInitScript(() => localStorage.setItem("hushd_cookie_consent", "essential"));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });

  // a full page load locks the private balance again (its key lives only in memory): unlock with the passkey
  const go = async (path: string) => {
    await page.goto(path);
    const unlock = page.getByRole("button", { name: "Use passkey" });
    if (await unlock.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) {
      await unlock.click();
      await expect(page.getByRole("heading", { name: "Open your private balance" })).toBeHidden({ timeout: 60_000 });
    }
  };

  // 1. a passkey account, opened by the relayer
  await page.goto("/app/balance");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByText("Your notes")).toBeVisible({ timeout: 60_000 });

  // 2. test USDC, then into the pool
  await go("/app/balance/add");
  await page.getByRole("button", { name: /Get test USDC/ }).click();
  await expect(page.getByRole("button", { name: "Max" })).toBeVisible({ timeout: 100_000 });
  await page.locator("#amount").fill("500");
  await page.getByRole("button", { name: "Add privately" }).click();
  await expect(page.getByText(/is now private/)).toBeVisible({ timeout: 120_000 });
  await go("/app/balance");
  await expect(page.locator("li", { hasText: "USDC" }).getByText("500")).toBeVisible({ timeout: 120_000 });

  // 3. describe the trade to the NEAR AI intake, check its signed draft in the form, and settle
  const intake = await intakeRoutes(page);
  await go("/app");
  const words = page.locator("#intake");
  await intake.attested;
  if (!intake.live) {
    // the stand-in: an answer signed by any key but the attested one is shown as not verified
    intake.signer = "other";
    await words.fill("Sell 200 USDC for BTC at the best price.");
    await page.getByRole("button", { name: "Draft my request" }).click();
    await expect(page.getByText("Not verified: the answer is signed by a key other than the attested one. Check every number yourself.")).toBeVisible({ timeout: 90_000 });
    intake.signer = "attested";
    await page.getByRole("button", { name: "Describe it" }).click();
  }
  await words.fill("Sell 200 USDC for BTC at the best price.");
  await page.getByRole("button", { name: "Draft my request" }).click();
  await expect(page.getByText("Answer signed inside the TEE by the attested key, checked in this browser")).toBeVisible({ timeout: 90_000 });
  console.log(`[${test.info().project.name}] intake: ${intake.live ? "the live NEAR AI model" : "a stand-in model (NEAR AI's attestation is unavailable)"}`);
  await expect(page.locator("#amount")).toHaveValue("200");
  await page.getByRole("button", { name: "Ask for quotes" }).click();
  await expect(page.getByText(/committed on the desk/)).toBeVisible({ timeout: 60_000 });
  // the enclave can take minutes when OutLayer's testnet workers are busy
  await expect(page.getByText(/Matched in the enclave: deal #\d+/)).toBeVisible({ timeout: 9 * 60_000 });
  await expect(page.getByText("Receipt")).toBeVisible({ timeout: 4 * 60_000 });
  const dealLink = page.getByRole("link", { name: /Open deal #\d+/ });
  const dealId = (await dealLink.textContent())!.match(/#(\d+)/)![1]!;
  console.log(`[${test.info().project.name}] deal #${dealId} settled; ${await moveTxOf(page)}`);

  // 4. the deal page: the public record says settled; the private side shows our terms
  await dealLink.click();
  await expect(page.getByText("Your side (private)")).toBeVisible();
  await expect(page.getByText("Settled").first()).toBeVisible({ timeout: 60_000 });

  // 5. a proof of that payment for judge.testnet, checked on /verify
  await go(`/app/prove?deal=${dealId}`);
  await page.getByPlaceholder("auditor.testnet").fill("judge.testnet");
  await page.getByRole("button", { name: "Make the proof" }).click();
  const check = page.getByRole("link", { name: "Check it yourself" });
  await expect(check).toBeVisible({ timeout: 120_000 });
  const href = await check.getAttribute("href");
  await page.goto(href!);
  await expect(page.getByText("Holds")).toBeVisible({ timeout: 60_000 });

  // 6. the maker paid a one-time address made for this deal; a private send moved the BTC into the balance
  await expectBoughtInBalance(page, go, "BTC", `[${test.info().project.name}] deal #${dealId}`);
});
