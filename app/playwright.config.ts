import { defineConfig, devices } from "@playwright/test";

/**
 * `pnpm e2e`: the public pages and the app shell against a local production build.
 * `HUSHD_E2E_TESTNET=1 pnpm e2e`: also the full deal on NEAR testnet (needs the live
 * services; set E2E_BASE_URL=https://hushd.net to run it against the deployed site).
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  ...(process.env.E2E_BASE_URL ? {} : { webServer: { command: "pnpm start", url: baseURL, reuseExistingServer: true, timeout: 60_000 } }),
});
