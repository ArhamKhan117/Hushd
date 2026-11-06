import { expect, test } from "@playwright/test";

const PAGES = ["/", "/app", "/app/deals", "/app/makers", "/app/agents", "/app/prove", "/verify", "/docs", "/agents", "/sdk", "/transparency", "/privacy", "/terms", "/security"];

test.beforeEach(async ({ context }) => {
  // essential cookies only, so the banner stays out of the way
  await context.addInitScript(() => {
    try {
      localStorage.setItem("hushd_cookie_consent", "essential");
    } catch {}
  });
});

for (const path of PAGES) {
  test(`${path} renders without overflow or errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(path);
    expect(res?.status(), `${path} status`).toBeLessThan(400);
    await expect(page.locator("h1").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal scroll").toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test("the proof checker refuses something that is not a proof", async ({ page }) => {
  await page.goto("/verify");
  await page.getByPlaceholder("hushdproof1…").fill("hushdproof1notreallyaproof");
  await page.getByRole("button", { name: "Check" }).click();
  // Next adds an empty route announcer with role=alert: look for ours, the one with text
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible();
});

test("the app asks to sign in before the desk", async ({ page }) => {
  await page.goto("/app");
  await expect(page.getByRole("button", { name: /passkey/i }).first()).toBeVisible();
});

test("the hosted MCP server lists its read tools", async ({ request }) => {
  const res = await request.post("/mcp", {
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  expect(res.ok()).toBeTruthy();
  const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  expect(names).toEqual(expect.arrayContaining(["hushd_status", "hushd_verify_proof"]));
});

test("dark theme keeps text readable", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const [bg, fg] = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return [s.backgroundColor, s.color];
  });
  expect(bg).not.toEqual(fg);
});

test.describe("agent policy wallets", () => {
  test("a signed-out visitor sees Hushd's policy wallets, read from chain", async ({ page }) => {
    await page.goto("/app/agents");
    await expect(page.getByText("Policy wallets", { exact: true })).toBeVisible();
    const hushd = page.getByRole("region", { name: "Hushd's policy wallets" });
    await expect(hushd.getByText("Demo agent")).toBeVisible({ timeout: 30_000 });
    const first = hushd.locator("[data-wallet]").first();
    await expect(first).toContainText(/Active|Frozen/);
    await expect(first.getByRole("link", { name: /on NearBlocks$/ })).toHaveAttribute("href", /^https:\/\/testnet\.nearblocks\.io\/address\/[0-9a-f]{64}$/);
    await expect(page.getByText("Who enforces what", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create a policy wallet for your agent" })).toBeVisible();
  });
});

test.describe("NEAR Intents previews (Hushd API stubbed)", () => {
  const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
  const APTOS_USDC = "nep141:aptos-usdc.omft.near";
  const ADDRESS = `0x${"11".repeat(20)}`;
  const TOKENS = {
    updatedAt: "2026-11-06T12:00:00.000Z",
    chains: [
      { id: "aptos", name: "Aptos", tokens: [{ assetId: APTOS_USDC, symbol: "USDC", decimals: 6, price: 0.9995 }, { assetId: "nep141:aptos.omft.near", symbol: "APT", decimals: 8, price: 0.61 }] },
      { id: "avax", name: "Avalanche", tokens: [{ assetId: "nep141:avax-usdc.omft.near", symbol: "USDC", decimals: 6, price: 0.9995 }] },
    ],
    hushd: [
      { assetId: USDC, symbol: "USDC", decimals: 6, price: 0.9995 },
      { assetId: "nep141:wrap.near", symbol: "wNEAR", decimals: 24, price: 3.74 },
      { assetId: "nep141:nbtc.bridge.near", symbol: "BTC", decimals: 8, price: 76000 },
    ],
  };
  const side = (t: { assetId: string; symbol: string; decimals: number; price: number }, chain: string, chainName: string) => ({ ...t, chain, chainName });
  const quote = (direction: "deposit" | "cashout") => {
    const other = side(TOKENS.chains[0]!.tokens[0]!, "aptos", "Aptos");
    const hushd = side(TOKENS.hushd[0]!, "near", "NEAR");
    return {
      confidential: false,
      direction,
      nearAccount: "0".repeat(64),
      from: direction === "deposit" ? other : hushd,
      to: direction === "deposit" ? hushd : other,
      timestamp: "2026-11-06T12:00:00.000Z",
      quote: { amountIn: "25000000", amountInFormatted: "25.0", amountInUsd: "24.98", amountOut: "24997517", amountOutFormatted: "24.997517", amountOutUsd: "24.98", minAmountOut: "24747541", timeEstimate: 35, withdrawFee: direction === "deposit" ? "0" : "20000" },
      quoteRequest: { slippageTolerance: 100, appFees: [{ recipient: "fees.near", fee: 1 }] },
    };
  };
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" };

  async function stub(page: import("@playwright/test").Page, asked: Record<string, unknown>[]) {
    await page.route("**/v1/intents/tokens", (r) => r.fulfill({ json: TOKENS, headers: cors }));
    await page.route("**/v1/intents/quote", async (r) => {
      if (r.request().method() === "OPTIONS") return r.fulfill({ status: 204, headers: cors });
      const b = r.request().postDataJSON() as Record<string, string>;
      asked.push(b);
      if (b.address !== ADDRESS) return r.fulfill({ status: 400, json: { error: "That is not a valid Aptos address. 1Click sends the USDC back to it if the swap cannot be filled." }, headers: cors });
      return r.fulfill({ json: quote(b.direction as "deposit" | "cashout"), headers: cors });
    });
  }
  // a click before hydration is lost: press the chip until it shows as chosen
  const choose = async (page: import("@playwright/test").Page, name: string) => {
    const chip = page.getByRole("button", { name });
    await expect(async () => {
      await chip.click();
      await expect(chip).toHaveAttribute("aria-pressed", "true", { timeout: 1_000 });
    }).toPass();
  };
  const noOverflow = async (page: import("@playwright/test").Page) =>
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal scroll").toBeLessThanOrEqual(0);

  test("a deposit from another chain shows a dry quote and 1Click's refusals in plain words", async ({ page }) => {
    const asked: Record<string, unknown>[] = [];
    await stub(page, asked);
    await page.goto("/app/balance/add");
    await choose(page, "From another chain");
    await page.getByLabel("You send").fill("25");
    await page.getByRole("button", { name: /^From chain:/ }).click();
    await page.getByRole("option", { name: /^Aptos/ }).click();
    const address = page.getByLabel("Your Aptos address, for refunds");
    await address.fill("not-an-address");
    const card = page.getByRole("region", { name: "Live quote" });
    await expect(card.getByRole("alert")).toHaveText(/not a valid Aptos address/);
    await address.fill(ADDRESS);
    await expect(card).toContainText("USDC on Aptos");
    await expect(card).toContainText("USDC in your Hushd balance");
    await expect(card).toContainText("24.997517 USDC");
    await expect(card).toContainText("About 35 seconds");
    await expect(card).toContainText("Public quote");
    await expect(page.getByText(/no deposit address is made and nothing is sent/)).toBeVisible();
    expect(asked.at(-1)).toMatchObject({ direction: "deposit", asset: APTOS_USDC, token: "USDC", amount: "25000000", address: ADDRESS });
    await noOverflow(page);
  });

  test("a cash out to another chain names the route and the fee to deliver there", async ({ page }) => {
    const asked: Record<string, unknown>[] = [];
    await stub(page, asked);
    await page.goto("/app/balance/cash-out");
    await choose(page, "To another chain");
    await page.getByLabel("Amount").fill("25");
    await page.getByRole("button", { name: /^To chain:/ }).click();
    await page.getByRole("option", { name: /^Aptos/ }).click();
    await page.getByLabel("Your Aptos address").fill(ADDRESS);
    const card = page.getByRole("region", { name: "Live quote" });
    await expect(card).toContainText("USDC on Aptos");
    await expect(card).toContainText("Fee to deliver on Aptos");
    await expect(card).toContainText("0.02 USDC");
    expect(asked.at(-1)).toMatchObject({ direction: "cashout", asset: APTOS_USDC, token: "USDC", amount: "25000000" });
    await noOverflow(page);
  });

  test("the transparency page lists the mainnet Intents trades, or says they wait for a go-ahead", async ({ page }) => {
    await page.route("**/v1/intents/trades", (r) => r.fulfill({ json: { steps: [] }, headers: cors }));
    await page.goto("/transparency");
    const section = page.locator("#intents");
    await expect(section.getByRole("heading", { name: /On NEAR.Intents \(mainnet\)/ })).toBeVisible();
    await expect(section).toContainText("built and waiting for the owner's go-ahead");
    await page.unroute("**/v1/intents/trades");
    const hash = "4Af6nGq3bWJ1m8Y2cZp9Q7tR5sV1xK3dL6hN8wE2fT9a";
    await page.route("**/v1/intents/trades", (r) =>
      r.fulfill({ json: { network: "mainnet", verifier: "intents.near", explorer: "https://nearblocks.io/txns/", steps: [{ step: "trade", txs: [hash], note: "one execute_intents, both legs or neither", at: "2026-11-07T10:05:00.000Z" }] }, headers: cors }),
    );
    await page.reload();
    await expect(section).toContainText("The direct trade");
    await expect(section.getByRole("link", { name: `Transaction ${hash} on NearBlocks` })).toHaveAttribute("href", `https://nearblocks.io/txns/${hash}`);
    await noOverflow(page);
  });
});
