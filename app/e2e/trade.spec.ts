import { expect, test, type Page } from "@playwright/test";
import { expectBoughtInBalance, moveTxOf } from "./balance";
import { deskWithRecords, stubDeskViews } from "./stubs";

/**
 * The Trade screen. The first part stands in for the Hushd API's market routes, so it checks
 * what the screen makes of known prices on any build. The second part is the whole trade on
 * NEAR testnet as a new user (HUSHD_E2E_TESTNET=1): a passkey account, test USDC added
 * privately, a sealed request from the ticket, and the deal settling in the workspace below.
 */

const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;

/** Candles that climb by `step` a minute (or per candle), ending now. */
function candles(interval: string, start: number, step: number, limit: number) {
  const span = { "1m": 1, "5m": 5, "15m": 15, "1h": 60, "4h": 240, "1d": 1440 }[interval]! * MIN;
  return Array.from({ length: limit }, (_, i) => {
    const c = start + step * i;
    return { t: NOW - (limit - 1 - i) * span, o: c - step, h: c + step, l: c - 2 * step, c, v: 10 + i };
  });
}

async function stubMarket(page: Page) {
  await page.route(/\/v1\/market\/mids$/, (r) => r.fulfill({ json: { source: "hyperliquid", at: Date.now(), mids: { BTC: 75_500, NEAR: 3.6 } } }));
  await page.route(/\/v1\/market\/candles\?/, (r) => {
    const q = new URL(r.request().url()).searchParams;
    const coin = q.get("coin")!;
    const interval = q.get("interval")!;
    const limit = Number(q.get("limit") ?? 200);
    const list = coin === "BTC" ? candles(interval, 75_000, 5, limit) : candles(interval, 3.5, 0.001, limit);
    return r.fulfill({ json: { source: "hyperliquid", coin, interval, at: Date.now(), candles: list } });
  });
}

test.describe("the Trade screen (market routes stubbed)", () => {
  // a dev server compiles the page on first use, which can take most of the default minute
  test.describe.configure({ timeout: 120_000 });
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("hushd_cookie_consent", "essential");
      } catch {}
    });
  });

  test("shows the pair's price, the last hour and the chart, from the API's numbers", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await stubMarket(page);
    await page.goto("/app/trade");
    await expect(page.getByRole("heading", { name: "Trade", level: 1 })).toBeVisible();
    const market = page.getByRole("region", { name: "Market" });
    await expect(market.getByText("75,500", { exact: true })).toBeVisible();
    // 75 one-minute closes climbing 5 a minute: 75,370 now against 75,070 an hour before
    await expect(market.getByText("+0.40%")).toBeVisible();
    await expect(page.getByText("BTC perp on Hyperliquid, in USD.", { exact: false })).toBeVisible();
    // 180 five-minute closes climbing 5 a candle: the last is 75,895
    await expect(page.getByRole("img", { name: /^BTC\/USDC, five-minute candles from Hyperliquid, last 75,895 USDC$/ })).toBeVisible();

    // a cross rate: BTC's mid over NEAR's
    await page.getByRole("button", { name: "Market: BTC/USDC" }).click();
    await page.getByRole("option", { name: /BTC\/wNEAR/ }).click();
    await expect(market.getByText("20,972", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: /^BTC\/wNEAR, five-minute cross rate from Hyperliquid/ })).toBeVisible();

    // the candle size is the viewer's to choose, and stays chosen
    await page.getByRole("button", { name: "hourly candles" }).click();
    await expect(page.getByRole("img", { name: /^BTC\/wNEAR, hourly cross rate/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("img", { name: /^BTC\/wNEAR, hourly cross rate/ })).toBeVisible();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal scroll").toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  test("a signed-out visitor sees the market, the makers and how to sign in", async ({ page }) => {
    await stubMarket(page);
    await page.goto("/app/trade");
    await expect(page.getByRole("heading", { name: "Open your private balance to trade" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Makers on the desk/ })).toBeVisible();
    await expect(page.getByText(/Open your private balance to see your requests/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Network status" }).getByText(/^Block \d/)).toBeVisible();
  });

  test("the makers panel shows each maker's record, and marks the one requests skip", async ({ page }) => {
    await stubMarket(page);
    await stubDeskViews(page, deskWithRecords());
    await page.goto("/app/trade");
    const panel = page.getByRole("region", { name: "Makers on the desk" });
    const row = (acc: string) => panel.locator(`tr[data-maker="${acc}"]`);
    await expect(row("steady.testnet")).toContainText("6 settled");
    await expect(row("steady.testnet")).toContainText("0 lapsed, 0%");
    await expect(row("lapser.testnet")).toContainText("3 lapsed, 50%");
    await expect(row("lapser.testnet")).toContainText("Skipped: lapses too often");
    await expect(row("fresh.testnet")).toContainText("1 lapsed, 100%");
    await expect(row("fresh.testnet")).not.toContainText("Skipped");
    await expect(panel).toContainText("Record: its last 20 deals that ended in the past week.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal scroll").toBeLessThanOrEqual(0);
  });
});

test.describe("a trade on NEAR testnet", () => {
  test.skip(!process.env.HUSHD_E2E_TESTNET, "set HUSHD_E2E_TESTNET=1 to run against testnet");
  test.describe.configure({ mode: "serial", timeout: 12 * 60_000 });

  test("a new passkey user trades on the Trade screen and sees the deal settle below", async ({ page, context, browserName }, info) => {
    test.skip(browserName !== "chromium", "the virtual authenticator is Chromium only");
    // the two projects run at once: each buys a different token, so a maker that wins both
    // deals pays them from different notes (one maker settling two deals of one token at once
    // can pick the same note twice)
    const coin = info.project.name === "phone" ? "wNEAR" : "BTC";
    const pair = `${coin}/USDC`;
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
        await expect(unlock).toBeHidden({ timeout: 60_000 });
      }
    };

    // 1. a passkey account, opened by the relayer
    await page.goto("/app/balance");
    await page.getByRole("button", { name: "Create a passkey" }).click();
    await expect(page.getByText("Your notes")).toBeVisible({ timeout: 60_000 });

    // 2. test USDC, then into the pool
    await go("/app/balance/add");
    await page.getByRole("button", { name: /Get test USDC/ }).click();
    await expect(page.getByText(/Test USDC sent to/)).toBeVisible({ timeout: 60_000 });
    // the page reads the new balance a few times; a slow RPC node can outlast that, so read it afresh
    await expect(async () => {
      if (!(await page.getByRole("button", { name: "Max" }).isVisible())) await go("/app/balance/add");
      await expect(page.getByRole("button", { name: "Max" })).toBeVisible({ timeout: 15_000 });
    }).toPass({ timeout: 120_000 });
    await page.locator("#amount").fill("500");
    await page.getByRole("button", { name: "Add privately" }).click();
    await expect(page.getByText(/is now private/)).toBeVisible({ timeout: 120_000 });

    // 3. the Trade screen: buy with 200 USDC, spot, sealed to the enclave
    await go("/app/trade");
    const ticket = page.getByRole("region", { name: "Ticket" });
    await expect(ticket.getByText(/Private balance: 500 USDC/)).toBeVisible({ timeout: 120_000 });
    if (!(await page.getByRole("button", { name: `Market: ${pair}` }).isVisible())) {
      await page.getByRole("button", { name: /^Market: / }).click();
      await page.getByRole("option", { name: new RegExp(`^${pair}`) }).click();
    }
    await ticket.getByRole("button", { name: `Buy ${coin}`, exact: true }).click();
    await ticket.getByRole("button", { name: "Spot", exact: true }).click();
    await ticket.locator("#amount").fill("200");
    await expect(ticket.getByText(new RegExp(`About [\\d.]+ ${coin} at the mid`))).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("region", { name: "Payoff" }).getByRole("img", { name: new RegExp(`Value of the package against the ${coin} price`) })).toBeVisible();
    await ticket.getByRole("button", { name: `Ask to buy ${coin}` }).click();
    await expect(ticket.getByText(/committed on the desk/)).toBeVisible({ timeout: 60_000 });
    await expect(ticket.getByText(/Matched in the enclave: deal #\d+/)).toBeVisible({ timeout: 4 * 60_000 });
    await expect(ticket.getByText("Receipt")).toBeVisible({ timeout: 4 * 60_000 });
    const dealId = (await ticket.getByRole("link", { name: /Open deal #\d+/ }).textContent())!.match(/#(\d+)/)![1]!;
    console.log(`[${info.project.name}] deal #${dealId} settled; ${await moveTxOf(ticket)}`);

    // 4. the workspace: the request settled, the deal with its private terms, then its receipt from the desk
    const work = page.getByRole("region", { name: "Your requests and deals" });
    await expect(work.getByRole("row", { name: new RegExp(`deal #${dealId}`) })).toContainText("Settled");
    await work.getByRole("tab", { name: /^Deals/ }).click();
    const row = work.locator(`tr[data-deal="${dealId}"]`);
    await expect(row).toContainText("200 USDC");
    await expect(row).toContainText(coin);
    await expect(row).toContainText("Settled", { timeout: 60_000 });
    await work.getByRole("tab", { name: /^Receipts/ }).click();
    await expect(work.getByRole("row", { name: new RegExp(`#${dealId}`) })).toContainText("Settled", { timeout: 60_000 });
    await expect(work.getByRole("link", { name: /Prove it/ }).first()).toBeVisible();

    // 5. the maker paid a one-time address made for this deal; a private send moved the tokens into the balance
    await expectBoughtInBalance(page, go, coin, `[${info.project.name}] deal #${dealId}`);
  });
});

