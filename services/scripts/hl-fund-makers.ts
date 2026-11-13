/**
 * The makers' Hyperliquid testnet accounts: show their addresses and margin, and share
 * whatever one of them received evenly across the three (one transfer from the owner is enough).
 * A transfer lands in spot, so --split first moves each maker's spot USDC to perps margin.
 *
 *   tsx scripts/hl-fund-makers.ts            # addresses, USDC each can use as margin, and spot USDC
 *   tsx scripts/hl-fund-makers.ts --split    # spot to perps, then even out the USDC across the three, from the richest
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addressOfKey, usdClassTransfer, usdSend } from "../src/hyperliquid.js";
import { hedgeSpotUsdc, hedgeWithdrawable } from "../src/market.js";

const ENV = join(new URL("../..", import.meta.url).pathname, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);

async function main() {
  const makers = ["A", "B", "C"].flatMap((m) => {
    const key = process.env[`MAKER_${m}_HL_KEY`];
    return key ? [{ name: `maker ${m}`, key, address: addressOfKey(key) }] : [];
  });
  if (makers.length === 0) throw new Error("no MAKER_*_HL_KEY in .env");
  const spot = await Promise.all(makers.map((m) => hedgeSpotUsdc(m.address)));
  let margin = await Promise.all(makers.map((m) => hedgeWithdrawable(m.address)));
  makers.forEach((m, i) => console.log(`${m.name}  ${m.address}  ${margin[i]!.toFixed(2)} USDC${spot[i]! >= 0.01 ? `  (${spot[i]!.toFixed(2)} more in spot)` : ""}`));
  if (!process.argv.includes("--split")) return;

  for (const [i, m] of makers.entries()) {
    // whole cents: Hyperliquid refuses more decimals than USDC's
    const amount = Math.floor(spot[i]! * 100) / 100;
    if (amount < 0.01) continue;
    await usdClassTransfer(m.key, String(amount), true, true);
    console.log(`moved ${amount} USDC of ${m.name} from spot to perps`);
  }
  if (spot.some((x) => x >= 0.01)) margin = await Promise.all(makers.map((m) => hedgeWithdrawable(m.address)));

  const total = margin.reduce((s, x) => s + x, 0);
  // keep a dollar back for Hyperliquid's transfer fees
  const each = Math.floor((total - 1) / makers.length);
  const from = margin.indexOf(Math.max(...margin));
  for (const [i, m] of makers.entries()) {
    const short = each - margin[i]!;
    if (i === from || short < 1) continue;
    await usdSend(makers[from]!.key, m.address, String(Math.floor(short)), true);
    console.log(`sent ${Math.floor(short)} USDC from ${makers[from]!.name} to ${m.name}`);
  }
}

main().catch((e) => {
  console.error("hl-fund-makers:", (e as Error).message);
  process.exit(1);
});
