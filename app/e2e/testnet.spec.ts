import { expect, test } from "@playwright/test";

/**
 * The whole product on NEAR testnet, as a new user: a passkey account, test tokens,
 * a private deposit, a desk deal settled privately, its deal page, and a proof for a
 * named reader checked on /verify. Needs the live contracts and services.
 */
test.skip(!process.env.HUSHD_E2E_TESTNET, "set HUSHD_E2E_TESTNET=1 to run against testnet");
test.describe.configure({ mode: "serial", timeout: 10 * 60_000 });

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
  await expect(page.getByRole("button", { name: "Max" })).toBeVisible({ timeout: 60_000 });
  await page.locator("#amount").fill("500");
  await page.getByRole("button", { name: "Add privately" }).click();
  await expect(page.getByRole("link", { name: "View on NearBlocks" })).toBeVisible({ timeout: 120_000 });
  await go("/app/balance");
  await expect(page.locator("li", { hasText: "USDC" }).getByText("500")).toBeVisible({ timeout: 120_000 });

  // 3. ask the desk with the form, and settle
  await go("/app");
  await page.getByRole("button", { name: "Fill the form" }).click();
  await page.locator("#amount").fill("200");
  await page.getByRole("button", { name: "Ask for quotes" }).click();
  await expect(page.getByText(/committed on the desk/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Matched in the enclave: deal #\d+/)).toBeVisible({ timeout: 4 * 60_000 });
  await expect(page.getByText("Receipt")).toBeVisible({ timeout: 4 * 60_000 });
  const dealLink = page.getByRole("link", { name: /Open deal #\d+/ });
  const dealId = (await dealLink.textContent())!.match(/#(\d+)/)![1]!;

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
});
