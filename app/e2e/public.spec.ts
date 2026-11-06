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
