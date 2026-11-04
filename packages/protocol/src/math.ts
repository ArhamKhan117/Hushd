/**
 * Exact integer math for token amounts. Every amount is a bigint in the token's
 * smallest unit; every division names its rounding, so no side of a deal ever
 * gains a unit by accident.
 */

export type Rounding = "floor" | "ceil" | "half_even";

export const U128_MAX = (1n << 128n) - 1n;

/** a * b / d, exact, rounded as asked. All inputs non-negative, d > 0. */
export function mulDiv(a: bigint, b: bigint, d: bigint, rounding: Rounding): bigint {
  if (a < 0n || b < 0n) throw new RangeError("mulDiv takes non-negative values");
  if (d <= 0n) throw new RangeError("division by zero or a negative divisor");
  const p = a * b;
  const q = p / d;
  const r = p % d;
  if (r === 0n) return q;
  switch (rounding) {
    case "floor":
      return q;
    case "ceil":
      return q + 1n;
    case "half_even": {
      const twice = r * 2n;
      if (twice > d) return q + 1n;
      if (twice < d) return q;
      return q % 2n === 0n ? q : q + 1n;
    }
  }
}

/** Convert an amount between decimal places (e.g. 6 to 24), rounding when precision is lost. */
export function rescale(amount: bigint, from: number, to: number, rounding: Rounding): bigint {
  if (to >= from) return amount * 10n ** BigInt(to - from);
  return mulDiv(amount, 1n, 10n ** BigInt(from - to), rounding);
}

/** "12.5" with 6 decimals -> 12500000n. Refuses more precision than the token has. */
export function parseUnits(s: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new SyntaxError(`not a decimal amount: ${s}`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`more than ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 12500000n with 6 decimals -> "12.5" (no trailing zeros). */
export function formatUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = a / base;
  const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Basis points of an amount, rounded as asked. */
export function bps(amount: bigint, points: number, rounding: Rounding): bigint {
  if (!Number.isInteger(points) || points < 0) throw new RangeError("basis points are a non-negative integer");
  return mulDiv(amount, BigInt(points), 10_000n, rounding);
}
