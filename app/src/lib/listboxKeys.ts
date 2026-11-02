/**
 * Keys inside an open dropdown list (components/ui/Select), kept free of React
 * so tests can run them. Follows the WAI-ARIA listbox pattern the way
 * a native select behaves: Up and Down step over disabled options and stop at
 * the ends, Home and End jump to the first and last option that can be
 * picked, Enter or Space picks, Escape closes, Tab closes and lets focus move
 * on, and typing letters jumps to the option that starts with them.
 */

export type ListboxItem = { label: string; disabled?: boolean };

export type ListboxAction =
  | { kind: "move"; index: number }
  | { kind: "pick"; index: number }
  /** Escape: close and put focus back on the button. */
  | { kind: "close" }
  /** Tab: close and let focus move on from the button. */
  | { kind: "leave" };

/** Options a PageUp or PageDown press skips over. */
const PAGE = 10;

/** How long a pause clears what has been typed so far, in milliseconds. */
export const TYPEAHEAD_RESET_MS = 600;

function enabled(items: readonly ListboxItem[], i: number): boolean {
  return i >= 0 && i < items.length && !items[i].disabled;
}

/** The first option that can be picked, or -1 when there is none. */
export function firstEnabled(items: readonly ListboxItem[]): number {
  return items.findIndex((it) => !it.disabled);
}

/** The last option that can be picked, or -1 when there is none. */
export function lastEnabled(items: readonly ListboxItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) if (!items[i].disabled) return i;
  return -1;
}

/**
 * Up to `steps` options from `from` towards `dir`, over disabled ones and
 * without wrapping. Stays put when nothing further can be picked.
 */
export function stepEnabled(items: readonly ListboxItem[], from: number, dir: 1 | -1, steps = 1): number {
  let at = from;
  for (let i = from + dir, taken = 0; i >= 0 && i < items.length && taken < steps; i += dir) {
    if (!items[i].disabled) {
      at = i;
      taken++;
    }
  }
  return enabled(items, at) ? at : from;
}

/** Where the highlight starts when the list opens: the chosen option, else the first that can be picked. */
export function openingIndex(items: readonly ListboxItem[], selected: number): number {
  return enabled(items, selected) ? selected : firstEnabled(items);
}

/**
 * What a key does while the list is open with `cursor` highlighted. Null for
 * keys the list leaves alone (letters go to `typeahead`).
 */
export function listboxKey(key: string, cursor: number, items: readonly ListboxItem[]): ListboxAction | null {
  switch (key) {
    case "Escape":
      return { kind: "close" };
    case "Tab":
      return { kind: "leave" };
  }
  if (firstEnabled(items) < 0) return null;
  const at = enabled(items, cursor) ? cursor : -1;
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: at < 0 ? firstEnabled(items) : stepEnabled(items, at, 1) };
    case "ArrowUp":
      return { kind: "move", index: at < 0 ? lastEnabled(items) : stepEnabled(items, at, -1) };
    case "PageDown":
      return { kind: "move", index: at < 0 ? firstEnabled(items) : stepEnabled(items, at, 1, PAGE) };
    case "PageUp":
      return { kind: "move", index: at < 0 ? lastEnabled(items) : stepEnabled(items, at, -1, PAGE) };
    case "Home":
      return { kind: "move", index: firstEnabled(items) };
    case "End":
      return { kind: "move", index: lastEnabled(items) };
    case "Enter":
    case " ":
      return at < 0 ? null : { kind: "pick", index: at };
    default:
      return null;
  }
}

/**
 * A key that types a character: one printable character and no Ctrl, Alt or
 * Cmd. Space only counts mid-word (`typing`), so "every t" can be typed;
 * otherwise Space picks.
 */
export function isTypeaheadKey(
  e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
  typing = false
): boolean {
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key !== " " || typing;
}

/**
 * Type-ahead: `typed` is what has been typed since the last pause, `char` the
 * new key. Returns the new text and the option to highlight (null when no
 * option starts with it). Typing one letter again and again goes round the
 * options that start with it; a longer run looks from the highlighted option
 * on, so "n" then "e" lands on "NEAR".
 */
export function typeahead(
  typed: string,
  char: string,
  cursor: number,
  items: readonly ListboxItem[]
): { typed: string; index: number | null } {
  const next = (typed + char).toLowerCase();
  const repeat = next.length > 1 && [...next].every((c) => c === next[0]);
  const query = repeat ? next[0] : next;
  // one letter (or the same letter again): start after the highlighted option,
  // so it moves on; a longer run: start on it, so it stays while it still matches
  const start = query.length === 1 ? cursor + 1 : Math.max(cursor, 0);
  const n = items.length;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (!items[i].disabled && items[i].label.toLowerCase().startsWith(query)) return { typed: next, index: i };
  }
  return { typed: next, index: null };
}
