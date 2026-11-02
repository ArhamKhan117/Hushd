"use client";

import { useEffect, useRef, type RefObject } from "react";

/** What Tab stops on. tabindex="-1" is never a stop: the dialogs' backdrops are buttons for a click, not for the keyboard. */
const NOT_SKIPPED = ':not([tabindex="-1"])';
const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
]
  .map((s) => `${s}${NOT_SKIPPED}`)
  .join(", ");

/** What Tab can reach inside `root`, in order, leaving out hidden and inert parts. */
function tabbableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => !el.closest("[inert]") && el.getClientRects().length > 0
  );
}

/**
 * Keyboard focus for a modal dialog, while `open`: focus starts on `initial`
 * (or the dialog itself), Tab and Shift+Tab go round inside it instead of
 * into the page behind, Escape calls `onClose`, and once it closes focus goes
 * back to whatever opened it.
 *
 * `onClose` is read when Escape is pressed, not watched: a parent that passes
 * a new function on every render would otherwise re-run this and pull focus
 * back to the first field while someone is typing in another.
 */
export function useModalFocus(
  dialog: RefObject<HTMLElement | null>,
  onClose: () => void,
  { initial, open = true }: { initial?: RefObject<HTMLElement | null>; open?: boolean } = {}
) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const root = dialog.current;
    if (!open || !root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initial?.current ?? root).focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = tabbableIn(root);
      const at = document.activeElement;
      if (!items.length) {
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const outside = !(at instanceof Node) || !root.contains(at);
      if (e.shiftKey && (outside || at === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || at === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [dialog, initial, open]);
}
