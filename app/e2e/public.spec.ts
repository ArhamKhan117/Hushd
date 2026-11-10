import { expect, test } from "@playwright/test";
import { deskWithRecords, signInWithPasskey, stubDeskViews, stubIntake } from "./stubs";

const DOCS = ["quickstart", "desk", "packages", "makers", "agents", "sdk", "contracts", "proofs", "x402", "privacy-model", "threat-model"];

/** Every page that renders without signing in. */
const PAGES = [
  "/",
  "/agents",
  "/sdk",
  "/verify",
  "/transparency",
  "/privacy",
  "/terms",
  "/cookies",
  "/security",
  "/docs",
  ...DOCS.map((d) => `/docs/${d}`),
  "/app",
  "/app/trade",
  "/app/deals",
  "/app/deals/2",
  "/app/makers",
  "/app/agents",
  "/app/prove",
  "/app/settings",
  "/app/balance",
  "/app/balance/add",
  "/app/balance/send",
  "/app/balance/receive",
  "/app/balance/cash-out",
  "/app/claim",
];

test.beforeEach(async ({ context }) => {
  // essential cookies only, so the banner stays out of the way
  await context.addInitScript(() => {
    try {
      localStorage.setItem("hushd_cookie_consent", "essential");
    } catch {}
  });
});

for (const path of PAGES) {
  test(`${path} renders without overflow or errors`, async ({ page, baseURL }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // A failed response also logs "Failed to load resource": only this site's own responses must
    // not fail, since the free RPCs answer 429 under load and the pages handle that.
    page.on("console", (m) => {
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && new URL(r.url()).origin === new URL(baseURL!).origin) errors.push(`${r.status()} ${r.url()}`);
    });
    // the CSP is report-only: what it would block shows up as these events, not as failures
    await page.addInitScript(() => {
      const seen: string[] = ((window as unknown as { __csp: string[] }).__csp = []);
      document.addEventListener("securitypolicyviolation", (e) => seen.push(`CSP ${e.effectiveDirective} ${e.blockedURI} at ${e.sourceFile}:${e.lineNumber}`));
    });
    const res = await page.goto(path);
    expect(res?.status(), `${path} status`).toBeLessThan(400);
    await expect(page.locator("h1").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "horizontal scroll").toBeLessThanOrEqual(0);
    errors.push(...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)));
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

test("a damaged claim link says so, and shows no amount", async ({ page }) => {
  await page.goto("/app/claim#AQIDBAUGBwgJ");
  await expect(page.getByRole("heading", { name: "This link does not work" })).toBeVisible();
  await expect(page.getByText("This is not a complete Hushd claim link. Copy all of it and try again.")).toBeVisible();
  await expect(page.getByText("You were paid")).toHaveCount(0);
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

test("the hosted MCP server names only the tools it serves, and a browser gets a note", async ({ request }) => {
  const init = await request.post("/mcp", {
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } },
  });
  expect(init.ok()).toBeTruthy();
  const { instructions } = ((await init.json()) as { result: { instructions: string } }).result;
  expect(instructions).toContain("read tools only");
  for (const tool of ["hushd_status", "hushd_makers", "hushd_desk_deals", "hushd_deal", "hushd_verify_proof"]) expect(instructions).toContain(tool);
  for (const wallet of ["hushd_address", "hushd_faucet", "hushd_shield", "hushd_balance", "hushd_trade", "hushd_prove", "hushd_pay_link"]) expect(instructions).not.toContain(wallet);
  const note = await request.get("/mcp", { headers: { accept: "text/html" } });
  expect(note.status()).toBe(200);
  expect(note.headers()["content-type"]).toContain("text/html");
  expect(await note.text()).toContain("claude mcp add --transport http");
  const json = await request.get("/mcp", { headers: { accept: "*/*" } });
  expect(json.status()).toBe(200);
  expect(((await json.json()) as { tools: string[] }).tools).toHaveLength(5);
});

test("every app page names itself in the tab", async ({ request }) => {
  const titles: [string, string][] = [
    ["/app", "Desk"],
    ["/app/trade", "Trade"],
    ["/app/deals", "Deals"],
    ["/app/deals/2", "Deal #2"],
    ["/app/makers", "Makers"],
    ["/app/agents", "Agents"],
    ["/app/prove", "Prove"],
    ["/app/settings", "Settings"],
    ["/app/balance", "Private balance"],
    ["/app/balance/add", "Add privately"],
    ["/app/balance/send", "Send privately"],
    ["/app/balance/receive", "Receive"],
    ["/app/balance/cash-out", "Cash out"],
    ["/app/claim", "Claim a payment"],
  ];
  for (const [path, title] of titles) {
    const html = await (await request.get(path)).text();
    expect(/<title>([^<]*)<\/title>/.exec(html)?.[1], path).toBe(`${title} · Hushd`);
  }
});

test("older deals load on request, down to the first one", async ({ page }) => {
  await page.goto("/app/deals");
  const older = page.getByRole("button", { name: "Show older deals" });
  // the line under the table says how far down the list goes: each page moves it
  const summary = page.getByText(/^(The \d+ newest deals, down to #\d+|All \d+ deals, newest first)\.$/);
  await expect(summary).toBeVisible({ timeout: 30_000 });
  for (let i = 0; i < 10; i++) {
    const before = (await summary.textContent()) ?? "";
    if (before.startsWith("All")) break;
    await older.click();
    await expect(summary).not.toHaveText(before, { timeout: 30_000 });
  }
  await expect(summary).toHaveText(/^All \d+ deals, newest first\.$/);
  await expect(older).toBeHidden();
  await expect(page.getByRole("link", { name: "#2", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "#0", exact: true })).toBeVisible();
});

test("a deal's receipt reads in words: repeats folded, amounts in tokens, events named", async ({ page }) => {
  await page.goto("/app/deals/3");
  const main = page.locator("main");
  await expect(main.getByText("Hyperliquid did not fill (3 times):")).toBeVisible({ timeout: 30_000 });
  await expect(main.getByText("1,000 USDC to a pool note")).toBeVisible();
  await expect(main.getByText(/Hedge order missed: order 1 of 3/)).toBeVisible({ timeout: 30_000 });
  await expect(main).not.toContainText("hedge_retry");
  await expect(main).not.toContainText("1000000000");
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

  test("an address on the sanctions list sees one neutral line, and the API is never asked", async ({ page }) => {
    const asked: Record<string, unknown>[] = [];
    await stub(page, asked);
    await page.goto("/app/balance/add");
    await choose(page, "From another chain");
    await page.getByLabel("You send").fill("25");
    await page.getByRole("button", { name: /^From chain:/ }).click();
    await page.getByRole("option", { name: /^Aptos/ }).click();
    // a digital currency address on OFAC's SDN list (published 2026-11-06)
    await page.getByLabel("Your Aptos address, for refunds").fill("TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81");
    const card = page.getByRole("region", { name: "Live quote" });
    await expect(card.getByRole("alert")).toHaveText("This address can't be used with Hushd.");
    await expect(card.getByRole("button", { name: /try again/i })).toHaveCount(0);
    expect(asked).toHaveLength(0);
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
    await expect(section).toContainText("No mainnet trade has run yet, so there is no transaction to list.");
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

test("the makers page shows each maker's record from the desk's deals, and which ones requests skip", async ({ page }) => {
  await stubDeskViews(page, deskWithRecords());
  await page.goto("/app/makers");
  const card = (name: string) => page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
  const steady = card("Steady").locator("[data-record]");
  await expect(steady).toContainText("Settled6");
  await expect(steady).toContainText("Lapsed0");
  await expect(steady).toContainText("Lapse rate0%");
  await expect(steady).toContainText("Last 6 ended deals. Requests ask it.");
  const lapser = card("Lapser").locator("[data-record]");
  await expect(lapser).toContainText("Lapse rate50%");
  await expect(lapser).toContainText("Requests skip it: more than 25% of its recent deals lapsed.");
  // one lapse on its only deal: too few to judge
  await expect(card("Fresh").locator("[data-record]")).toContainText("Requests ask it; judged once 5 of its deals have ended.");
  await expect(page.getByText(/^Each maker's record counts its last 20 deals that ended in the past week/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal scroll").toBeLessThanOrEqual(0);
});

test.describe("NEAR AI intake (Hushd API stubbed)", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "the virtual authenticator is Chromium only");

  test("a drafted request shows what the API verified about the model, and how to check it yourself", async ({ page, context }) => {
    const { modelPub } = await stubIntake(page);
    await page.goto("/app");
    await signInWithPasskey(page, context);
    await page.locator("#intake").fill("Sell 200 USDC for BTC at the best price.");
    await page.getByRole("button", { name: "Draft my request" }).click();
    await expect(page.getByText("Answer signed inside the TEE by the attested key, checked in this browser")).toBeVisible({ timeout: 60_000 });
    const att = page.getByRole("region", { name: "The model's attestation" });
    await expect(att).toContainText("stand-in/model");
    await expect(att).toContainText(modelPub);
    await expect(att).toContainText("Intel TDXup to date");
    await expect(att).toContainText("NVIDIA GPU evidenceverified");
    await expect(att.locator("time")).toHaveAttribute("datetime", "2026-11-10T09:30:00.000Z");
    await expect(att).toContainText("This part is checked by the Hushd API, not by your browser");
    await expect(att.getByRole("link", { name: "Check it yourself on NEAR AI" })).toHaveAttribute("href", "https://cloud.near.ai/verify");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), "horizontal scroll").toBeLessThanOrEqual(0);
  });

  test("with NEAR AI down the intake says it is off and opens the form", async ({ page, context }) => {
    await stubIntake(page, () => ({ model: "stand-in/model", enabled: false, unavailable: "NEAR AI Cloud answered HTTP 500" }));
    await page.goto("/app");
    await signInWithPasskey(page, context);
    // the form is open from the start; the words say why they are off
    await expect(page.getByRole("button", { name: "Fill the form" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("You sell", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Describe it" }).click();
    const off = page.getByRole("status", { name: "The intake is off" });
    await expect(off).toContainText("nothing you type here is sent anywhere");
    await expect(off).toContainText("The Hushd API said: NEAR AI Cloud answered HTTP 500");
    await expect(page.locator("#intake")).toHaveCount(0);
    await off.getByRole("button", { name: "Fill the form" }).click();
    await expect(page.getByRole("button", { name: "Fill the form" }).first()).toHaveAttribute("aria-pressed", "true");
  });
});
