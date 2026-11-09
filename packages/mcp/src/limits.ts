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

/** The owner's other rules: a date the limits stop working, and who the agent may pay. */
export interface Rules {
  expiresAt?: Date;
  /** hushd1... addresses and NEAR accounts this agent may send or cash out to (any, when unset). */
  allowTo?: Set<string>;
}

export function parseRules(env: { HUSHD_LIMITS_EXPIRE?: string; HUSHD_ALLOW_TO?: string }): Rules {
  const rules: Rules = {};
  if (env.HUSHD_LIMITS_EXPIRE) {
    const d = new Date(env.HUSHD_LIMITS_EXPIRE);
    if (Number.isNaN(d.getTime())) throw new Error(`Bad HUSHD_LIMITS_EXPIRE "${env.HUSHD_LIMITS_EXPIRE}" (want a date, e.g. 2026-12-01)`);
    rules.expiresAt = d;
  }
  if (env.HUSHD_ALLOW_TO) rules.allowTo = new Set(env.HUSHD_ALLOW_TO.split(",").map((x) => x.trim()).filter(Boolean));
  return rules;
}

export class Limits {
  private ledger: { day: string; spent: Record<string, string> };

  constructor(
    readonly net: HushdNetwork,
    readonly perPayment: Map<string, bigint>,
    readonly perDay: Map<string, bigint>,
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
    readonly rules: Rules = {},
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
  check(token: string, amount: bigint, to?: string): void {
    if (this.rules.expiresAt && this.now() >= this.rules.expiresAt) throw new Error(`This agent's spending limits expired on ${this.rules.expiresAt.toISOString().slice(0, 10)}, so it may not spend`);
    if (to !== undefined && this.rules.allowTo && !this.rules.allowTo.has(to)) throw new Error(`${to} is not on this agent's list of payees`);
    const t = tokenInfo(this.net, token);
    const one = this.perPayment.get(t.id);
    const day = this.perDay.get(t.id);
    if (one === undefined || day === undefined) throw new Error(`No spending limit is set for ${t.symbol}, so this agent may not spend it`);
    if (amount > one) throw new Error(`${formatUnits(amount, t.decimals)} ${t.symbol} is over the limit of ${formatUnits(one, t.decimals)} per payment`);
    const after = this.spentToday(t.id) + amount;
    if (after > day) throw new Error(`That would make ${formatUnits(after, t.decimals)} ${t.symbol} today, over the daily limit of ${formatUnits(day, t.decimals)}`);
  }

  /**
   * A link pays whoever opens it first, so it counts like any payment, and an agent the
   * owner limited to a list of payees may not pay one at all.
   */
  checkLink(token: string, amount: bigint): void {
    this.check(token, amount);
    if (this.rules.allowTo) throw new Error("This agent may pay only the payees on its list, and anyone holding a link can claim it, so it may not pay as a link");
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
    const tokens = [...this.perPayment.keys()].map((id) => {
      const t = tokenInfo(this.net, id);
      return {
        token: t.symbol,
        perPayment: formatUnits(this.perPayment.get(id)!, t.decimals),
        perDay: formatUnits(this.perDay.get(id) ?? 0n, t.decimals),
        spentToday: formatUnits(this.spentToday(id), t.decimals),
      };
    });
    return { tokens, expires: this.rules.expiresAt?.toISOString() ?? null, payees: this.rules.allowTo ? [...this.rules.allowTo] : "any" };
  }
}
