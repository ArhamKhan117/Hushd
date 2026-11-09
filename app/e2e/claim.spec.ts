import { expect, test, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";

/**
 * Paying as a link on NEAR testnet, as two new users in two browsers: A adds test USDC
 * privately and pays 25 USDC as a link; B opens the link, makes a passkey, claims it and
 * sees it in its private balance; A then sees the link claimed, with nothing to take back.
 * Needs the live contracts and services.
 */
test.skip(!process.env.HUSHD_E2E_TESTNET, "set HUSHD_E2E_TESTNET=1 to run against testnet");
test.describe.configure({ mode: "serial", timeout: 10 * 60_000 });

/** A passkey that answers on its own, and the cookie banner out of the way. */
async function asPasskeyUser(context: BrowserContext, page: Page) {
  await context.addInitScript(() => localStorage.setItem("hushd_cookie_consent", "essential"));
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
}

/** A full page load locks the private balance again (its key lives only in memory): unlock with the passkey. */
async function go(page: Page, path: string) {
  await page.goto(path);
  const unlock = page.getByRole("button", { name: "Use passkey" });
  if (await unlock.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) {
    await unlock.click();
    await expect(page.getByRole("heading", { name: "Open your private balance" })).toBeHidden({ timeout: 60_000 });
  }
}

test("a payment link is claimed by a new user, and the payer sees it claimed", async ({ browser, page, context, browserName }, testInfo) => {
  test.skip(browserName !== "chromium", "the virtual authenticator is Chromium only");
  await asPasskeyUser(context, page);

  // A: a passkey account, test USDC, then 100 into the pool
  await page.goto("/app/balance");
  await page.getByRole("button", { name: "Create a passkey" }).click();
  await expect(page.getByText("Your notes")).toBeVisible({ timeout: 60_000 });
  await go(page, "/app/balance/add");
  await page.getByRole("button", { name: /Get test USDC/ }).click();
  await expect(page.getByRole("button", { name: "Max" })).toBeVisible({ timeout: 100_000 });
  await page.locator("#amount").fill("100");
  await page.getByRole("button", { name: "Add privately" }).click();
  await expect(page.getByText(/is now private/)).toBeVisible({ timeout: 120_000 });
  await go(page, "/app/balance");
  await expect(page.locator("li", { hasText: "USDC" }).getByText("100")).toBeVisible({ timeout: 120_000 });

  // A pays 25 USDC as a link
  await go(page, "/app/balance/send");
  await page.getByRole("button", { name: "As a link" }).click();
  await expect(page.getByRole("button", { name: "As a link" })).toHaveAttribute("aria-pressed", "true");
  await page.locator("#amount").fill("25");
  await page.getByRole("button", { name: "Make a link" }).click();
  await expect(page.getByText("Anyone with this link can claim it. Share it privately.")).toBeVisible({ timeout: 120_000 });
  const url = (await page.getByLabel("Claim link").textContent())!.trim();
  expect(url).toMatch(/\/app\/claim#[A-Za-z0-9_-]{100,}$/);
  const sent = page.locator("[data-link-state]").first();
  await expect(sent).toContainText("25 USDC");
  await expect(sent).toContainText("Waiting", { timeout: 60_000 });
  await expect(sent.getByRole("button", { name: "Take back" })).toBeVisible();

  // B: another browser, a new passkey user who opens the link
  const use = testInfo.project.use;
  const options: BrowserContextOptions = {
    baseURL: use.baseURL ?? process.env.E2E_BASE_URL ?? "http://localhost:3000",
    ...(use.viewport ? { viewport: use.viewport } : {}),
    ...(use.userAgent ? { userAgent: use.userAgent } : {}),
    ...(use.deviceScaleFactor ? { deviceScaleFactor: use.deviceScaleFactor } : {}),
    ...(use.isMobile !== undefined ? { isMobile: use.isMobile } : {}),
    ...(use.hasTouch !== undefined ? { hasTouch: use.hasTouch } : {}),
  };
  const bContext = await browser.newContext(options);
  const b = await bContext.newPage();
  try {
    await asPasskeyUser(bContext, b);
    await b.goto(new URL(url).pathname + new URL(url).hash);
    // the amount shows only once the pool holds the note, unclaimed
    await expect(b.getByText("In the pool, and nobody has claimed it yet.")).toBeVisible({ timeout: 60_000 });
    await expect(b.getByText("You were paid")).toBeVisible();
    await b.getByRole("button", { name: "Create a passkey" }).click();
    const claim = b.getByRole("button", { name: "Claim 25 USDC" });
    await expect(claim).toBeVisible({ timeout: 60_000 });
    await claim.click();
    await expect(b.getByText("25 USDC is now in your private balance")).toBeVisible({ timeout: 180_000 });
    const tx = (await b.getByRole("link", { name: "View on NearBlocks" }).getAttribute("href"))!;
    expect(tx).toMatch(/\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    console.log(`[${testInfo.project.name}] claim transaction: ${tx}`);
    testInfo.annotations.push({ type: "claim transaction", description: tx });

    // B's private balance holds the 25 USDC (an in-app link keeps the balance open)
    await b.getByRole("link", { name: "See your balance" }).click();
    await expect(b.locator("li", { hasText: "USDC" }).getByText("25", { exact: true })).toBeVisible({ timeout: 120_000 });

    // opening the link again says it was claimed, and offers nothing to claim
    await b.goto(new URL(url).pathname + new URL(url).hash);
    await expect(b.getByRole("heading", { name: "This link was already claimed." })).toBeVisible({ timeout: 60_000 });
    await expect(b.getByRole("button", { name: /Claim/ })).toHaveCount(0);
  } finally {
    await bContext.close();
  }

  // A: the link reads as claimed, and there is nothing left to take back
  await go(page, "/app/balance/send");
  await page.getByRole("button", { name: "As a link" }).click();
  const row = page.locator("[data-link-state]").first();
  await expect(row).toHaveAttribute("data-link-state", "claimed", { timeout: 60_000 });
  await expect(row).toContainText("Claimed");
  await expect(row.getByRole("button", { name: "Take back" })).toHaveCount(0);
  await go(page, "/app/balance");
  await expect(page.locator("li", { hasText: "USDC" }).getByText("75", { exact: true })).toBeVisible({ timeout: 120_000 });
});
