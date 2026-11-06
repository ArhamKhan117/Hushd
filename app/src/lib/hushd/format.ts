import { formatUnits, parseUnits } from "@hushd/protocol";
import { tokenInfo, type TokenInfo } from "@hushd/sdk";
import { IS_TESTNET, NETWORK } from "./config";

export const TOKENS = NETWORK.tokens;

export function fmt(token: string, amount: bigint, maxDecimals = 6): string {
  const t = tokenInfo(NETWORK, token);
  const s = formatUnits(amount, t.decimals);
  const [w, f] = s.split(".");
  const whole = Number(w).toLocaleString("en-US");
  return f ? `${whole}.${f.slice(0, maxDecimals)}` : whole;
}

export function symbol(token: string): string {
  return tokenInfo(NETWORK, token).symbol;
}

/** Parse what someone typed; null when it is not an amount this token can hold. */
export function parseAmount(token: string, input: string): bigint | null {
  try {
    const v = parseUnits(input.replace(/,/g, ""), tokenInfo(NETWORK, token).decimals);
    return v > 0n ? v : null;
  } catch {
    return null;
  }
}

/** The real tokens Hushd lists on mainnet, in words. */
const MAINNET_WORDS: Record<string, { short: string; long: string }> = {
  USDC: { short: "Native USDC", long: "Native USDC, issued by Circle" },
  wNEAR: { short: "Wrapped NEAR", long: "Wrapped NEAR, NEAR as a NEP-141 token" },
  BTC: { short: "nBTC", long: "nBTC, Bitcoin bridged to NEAR by the Omni Bridge" },
};

/** What a listed token is: a test token with a faucet on testnet, the real token on mainnet. */
export function tokenWords(t: TokenInfo): { short: string; long: string } {
  if (IS_TESTNET) return { short: `Test ${t.symbol}`, long: `Test ${t.symbol}, ${t.decimals} decimals, with a faucet` };
  const w = MAINNET_WORDS[t.symbol];
  return { short: w?.short ?? t.symbol, long: `${w?.long ?? t.symbol}, ${t.decimals} decimals` };
}
