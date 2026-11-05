import { formatUnits, parseUnits } from "@hushd/protocol";
import { tokenInfo } from "@hushd/sdk";
import { NETWORK } from "./config";

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
