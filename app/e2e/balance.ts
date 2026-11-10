import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A settled deal paid a one-time address made for it; this tab then moved the tokens into the
 * balance with a private send. What the run shows of it: its transaction, or why it was left
 * to the next sync.
 */
export async function moveTxOf(where: Locator | Page): Promise<string> {
  // the run's last step says where the tokens are once the move is done or left for later
  await expect(where.getByText(/The tokens are in your private balance\.|on their way into your balance/)).toBeVisible({ timeout: 3 * 60_000 });
  const moved = where.getByText("The private send into your balance is on chain.");
  if (await moved.isVisible()) return `moved into the balance in ${(await moved.getByRole("link").getAttribute("href"))?.split("/").pop()}`;
  const later = where.getByText(/on their way into your balance/);
  return (await later.isVisible()) ? `${await later.textContent()}` : "no word of the move";
}

/**
 * After a deal that sold 200 of 500 USDC: the bought tokens are in the private balance. A
 * reload unlocks again and syncs, which moves a note this tab did not.
 */
export async function expectBoughtInBalance(page: Page, go: (path: string) => Promise<void>, coin: string, label: string) {
  await go("/app/balance");
  const amount = (token: string) => page.locator("li", { hasText: token }).locator(".tnum");
  let first = true;
  await expect(async () => {
    if (!first) await go("/app/balance");
    first = false;
    await expect(amount(coin)).toHaveText(/\d/, { timeout: 30_000 });
  }).toPass({ timeout: 4 * 60_000 });
  await expect(amount("USDC")).toHaveText("300", { timeout: 60_000 });
  const address = await page.locator("p", { hasText: "Your receive address" }).locator("span").textContent();
  console.log(`${label}: ${await amount(coin).textContent()} ${coin} in the balance of ${address}`);
}
