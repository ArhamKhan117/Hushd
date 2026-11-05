/**
 * Spending limits for an agent: a cap per payment and per UTC day, per token, in the
 * token's own units ("USDC=100,wNEAR=50"). What was spent today is kept in a file, so
 * a restart does not reset the day. Anything over a limit is refused before proving.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseUnits, formatUnits } from "@hushd/protocol";
import { tokenInfo, type HushdNetwork } from "@hushd/sdk";

export const DEFAULT_PER_PAYMENT = "USDC=100,wNEAR=50,BTC=0.002";
export const DEFAULT_PER_DAY = "USDC=500,wNEAR=250,BTC=0.01";

export function parseCaps(net: HushdNetwork, s: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const [sym, amount] = part.split("=");
    if (!sym || !amount) throw new Error(`Bad limit "${part}" (want SYMBOL=amount)`);
    const t = tokenInfo(net, sym.trim());
    out.set(t.id, parseUnits(amount.trim(), t.decimals));
  }
  return out;
}

export class Limits {
  private ledger: { day: string; spent: Record<string, string> };

  constructor(
    readonly net: HushdNetwork,
    readonly perPayment: Map<string, bigint>,
    readonly perDay: Map<string, bigint>,
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { day: this.today(), spent: {} };
  }

  private today() {
    return this.now().toISOString().slice(0, 10);
  }

  private roll() {
    if (this.ledger.day !== this.today()) this.ledger = { day: this.today(), spent: {} };
  }

  spentToday(token: string): bigint {
    this.roll();
    return BigInt(this.ledger.spent[token] ?? "0");
  }

  /** Throws when `amount` of `token` would break a limit. Tokens with no limit set cannot be spent. */
  check(token: string, amount: bigint): void {
    const t = tokenInfo(this.net, token);
    const one = this.perPayment.get(t.id);
    const day = this.perDay.get(t.id);
    if (one === undefined || day === undefined) throw new Error(`No spending limit is set for ${t.symbol}, so this agent may not spend it`);
    if (amount > one) throw new Error(`${formatUnits(amount, t.decimals)} ${t.symbol} is over the limit of ${formatUnits(one, t.decimals)} per payment`);
    const after = this.spentToday(t.id) + amount;
    if (after > day) throw new Error(`That would make ${formatUnits(after, t.decimals)} ${t.symbol} today, over the daily limit of ${formatUnits(day, t.decimals)}`);
  }

  record(token: string, amount: bigint): void {
    this.roll();
    this.ledger.spent[token] = (this.spentToday(token) + amount).toString();
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.ledger));
  }

  maxFor(token: string): bigint {
    const one = this.perPayment.get(token) ?? 0n;
    const left = (this.perDay.get(token) ?? 0n) - this.spentToday(token);
    return one < left ? one : left > 0n ? left : 0n;
  }

  describe() {
    return [...this.perPayment.keys()].map((id) => {
      const t = tokenInfo(this.net, id);
      return {
        token: t.symbol,
        perPayment: formatUnits(this.perPayment.get(id)!, t.decimals),
        perDay: formatUnits(this.perDay.get(id) ?? 0n, t.decimals),
        spentToday: formatUnits(this.spentToday(id), t.decimals),
      };
    });
  }
}
