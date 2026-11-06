/**
 * The makers' Hyperliquid testnet accounts: show their addresses and margin, and share
 * whatever one of them received evenly across the three (one transfer from the owner is enough).
 *
 *   tsx scripts/hl-fund-makers.ts            # addresses and USDC each can use as margin
 *   tsx scripts/hl-fund-makers.ts --split    # even out the USDC across the three, from the richest
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { addressOfKey, usdSend } from "../src/hyperliquid.js";
import { testnetWithdrawable } from "../src/market.js";

const ENV = join(new URL("../..", import.meta.url).pathname, ".env");
if (existsSync(ENV)) process.loadEnvFile(ENV);

async function main() {
  const makers = ["A", "B", "C"].flatMap((m) => {
    const key = process.env[`MAKER_${m}_HL_KEY`];
    return key ? [{ name: `maker ${m}`, key, address: addressOfKey(key) }] : [];
  });
  if (makers.length === 0) throw new Error("no MAKER_*_HL_KEY in .env");
  const margin = await Promise.all(makers.map((m) => testnetWithdrawable(m.address)));
  makers.forEach((m, i) => console.log(`${m.name}  ${m.address}  ${margin[i]!.toFixed(2)} USDC`));
  if (!process.argv.includes("--split")) return;

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
