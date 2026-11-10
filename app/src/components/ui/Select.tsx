"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  TYPEAHEAD_RESET_MS,
  isTypeaheadKey,
  listboxKey,
  openingIndex,
  typeahead,
} from "@/lib/listboxKeys";

/**
 * The app's dropdown, in place of the native select (whose menu is the
 * operating system's, grey on macOS). A button that opens a list of options:
 * the WAI-ARIA collapsible listbox, with the keys from lib/listboxKeys and
 * type-ahead. The list is portaled (into the dialog it sits in, else the
 * page) and placed with fixed coordinates, so a scrolling or clipped parent
 * never cuts it off; it opens upward when there is more room above.
 */

export type SelectOption<V extends string | number = string> = {
  value: V;
  /** What the button and the row show, and what type-ahead matches. */
  label: string;
  /** A mark before the label, such as an icon. */
  icon?: ReactNode;
  /** A second, quieter line in the row. */
  description?: string;
  /** A small tag at the row's end, such as "Soon". */
  badge?: string;
  disabled?: boolean;
};

type Props<V extends string | number> = {
  value: V;
  onChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  /** What is being chosen, e.g. "Network". The button reads it with the current choice. */
  label: string;
  /**
   * "pill": a compact pill beside a big value. "field": the form field look
   * (.hd-input). "row": a quiet full-width outlined row, as in the app's sidebar.
   * Size it with `className`.
   */
  variant?: "pill" | "field" | "row";
  /** Line the list up with the button's left ("start") or right ("end") edge. */
  align?: "start" | "end";
  className?: string;
  disabled?: boolean;
  /** Shown when `value` matches no option. */
  placeholder?: string;
  id?: string;
};

const GUTTER = 8;
const GAP = 6;
const MAX_HEIGHT = 320;
/** The pill is narrow; its list is at least this wide so rows can breathe. */
const PILL_MIN_WIDTH = 200;

function Chevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={`shrink-0 text-mute transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""} ${className ?? ""}`}
    >
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0 text-foreground">
      <path d="m5.5 12.5 4 4 9-9" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Select<V extends string | number>({
  value,
  onChange,
  options,
  label,
  variant = "field",
  align = "start",
  className = "",
  disabled = false,
  placeholder = "Choose",
  id,
}: Props<V>) {
  const autoId = useId();
  const baseId = id ?? autoId;
  const listId = `${baseId}-list`;
  const optId = (i: number) => `${baseId}-opt-${i}`;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  /** Where the open list is portaled; null while closed. */
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [cursor, setCursor] = useState(-1);
  const open = host !== null;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const show = useCallback(
    (at?: number) => {
      const btn = buttonRef.current;
      if (!btn || disabled) return;
      setCursor(at ?? openingIndex(options, selectedIndex));
      // inside a modal dialog the list must stay in it, or the dialog's
      // aria-modal hides it from screen readers
      setHost(btn.closest<HTMLElement>('[role="dialog"]') ?? document.body);
    },
    [disabled, options, selectedIndex]
  );

  const close = useCallback((refocus: boolean) => {
    setHost(null);
    typed.current.text = "";
    if (refocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  function pick(i: number) {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close(true);
  }

  /** Type-ahead from `cursor`; resets after a pause. Returns the option to highlight. */
  function typeTo(char: string, from: number): number | null {
    const now = Date.now();
    const prev = now - typed.current.at > TYPEAHEAD_RESET_MS ? "" : typed.current.text;
    const r = typeahead(prev, char, from, options);
    typed.current = { text: r.typed, at: now };
    return r.index;
  }

  // Place the list against the button, flip it above when below is short, and
  // follow the button while anything scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!host) return;
    const btn = buttonRef.current;
    const pop = popRef.current;
    const list = listRef.current;
    if (!btn || !pop || !list) return;

    function place() {
      if (!btn || !pop || !list) return;
      const r = btn.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = window.visualViewport?.height ?? window.innerHeight;
      const width = Math.min(Math.max(r.width, variant === "pill" ? PILL_MIN_WIDTH : 0), vw - GUTTER * 2);
      const left = Math.max(GUTTER, Math.min(align === "end" ? r.right - width : r.left, vw - GUTTER - width));
      const below = vh - r.bottom - GAP - GUTTER;
      const above = r.top - GAP - GUTTER;
      // the whole list, borders included, however short its box is now
      const want = Math.min(list.scrollHeight + list.offsetHeight - list.clientHeight, MAX_HEIGHT);
      const down = below >= want || below >= above;
      pop.dataset.side = down ? "bottom" : "top";
      pop.style.width = `${width}px`;
      list.style.maxHeight = `${Math.max(0, Math.min(MAX_HEIGHT, down ? below : above))}px`;
      const top = down ? r.bottom + GAP : r.top - GAP - list.offsetHeight;
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      // A transformed parent becomes the box fixed elements are placed in;
      // measure where the list landed and take that offset back out.
      const got = pop.getBoundingClientRect();
      const dx = got.left - left;
      const dy = got.top - top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        pop.style.left = `${left - dx}px`;
        pop.style.top = `${top - dy}px`;
      }
    }

    place();
    let frame = 0;
    const follow = (e: Event) => {
      if (e.type === "scroll" && e.target instanceof Node && pop.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(place);
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    window.visualViewport?.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      window.visualViewport?.removeEventListener("resize", follow);
    };
  }, [host, align, variant]);

  // On open: focus the list and bring the chosen option to the middle.
  useLayoutEffect(() => {
    if (!host) return;
    const list = listRef.current;
    if (!list) return;
    list.focus({ preventScroll: true });
    const opt = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (opt) list.scrollTop = opt.offsetTop - list.clientHeight / 2 + opt.offsetHeight / 2;
    // only when it opens; the cursor effect below keeps the highlight in view
  }, [host]);

  // Keep the highlighted option in view as the keys move it.
  useEffect(() => {
    const list = listRef.current;
    if (!host || !list || cursor < 0) return;
    const opt = list.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    if (!opt) return;
    const top = opt.offsetTop;
    const bottom = top + opt.offsetHeight;
    const pad = 6;
    if (top - pad < list.scrollTop) list.scrollTop = Math.max(0, top - pad);
    else if (bottom + pad > list.scrollTop + list.clientHeight) list.scrollTop = bottom + pad - list.clientHeight;
  }, [host, cursor]);

  // A click or tap anywhere else closes it. Escape is caught before anything
  // else hears it, so a dialog around the dropdown stays open.
  useEffect(() => {
    if (!host) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (buttonRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [host, close]);

  function onButtonKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    } else if (isTypeaheadKey(e)) {
      e.preventDefault();
      const at = typeTo(e.key, selectedIndex);
      show(at ?? undefined);
    }
  }

  function onListKey(e: KeyboardEvent<HTMLDivElement>) {
    const typing = typed.current.text !== "" && Date.now() - typed.current.at <= TYPEAHEAD_RESET_MS;
    if (isTypeaheadKey(e, typing)) {
      e.preventDefault();
      const at = typeTo(e.key, cursor);
      if (at !== null) setCursor(at);
      return;
    }
    const action = listboxKey(e.key, cursor, options);
    if (!action) return;
    switch (action.kind) {
      case "leave":
        // focus goes back to the button now, and Tab carries on from there
        close(true);
        return;
      case "close":
        e.preventDefault();
        close(true);
        return;
      case "move":
        e.preventDefault();
        setCursor(action.index);
        return;
      case "pick":
        e.preventDefault();
        pick(action.index);
        return;
    }
  }

  // a second line that only repeats the label is left out; if any row has
  // one, every row is the same height
  const secondLine = (o: SelectOption<V>) =>
    o.description && o.description.toLowerCase() !== o.label.toLowerCase() ? o.description : null;
  const twoLine = options.some((o) => secondLine(o));
  const triggerLabel = selected?.label ?? placeholder;
  const icon = selected?.icon;

  const trigger =
    variant === "row"
      ? "flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left text-[13px] text-soft transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 aria-expanded:bg-surface aria-expanded:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
      : variant === "pill"
      ? `flex h-11 items-center gap-2 rounded-full bg-panel pr-3 text-[15px] font-medium text-foreground shadow-card transition-shadow duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/50 aria-expanded:ring-2 aria-expanded:ring-foreground/15 disabled:cursor-not-allowed disabled:opacity-45 ${
          icon ? "pl-1.5" : "pl-3.5"
        }`
      : `hd-input relative flex items-center gap-2.5 pr-9 text-left disabled:cursor-not-allowed disabled:opacity-45 ${
          icon ? "pl-2" : ""
        }`;

  return (
    <>
      <button
        ref={buttonRef}
        id={baseId}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${triggerLabel}`}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={onButtonKey}
        className={`${trigger} ${className}`}
      >
        {icon && (
          <span aria-hidden className="flex shrink-0">
            {icon}
          </span>
        )}
        <span className={`min-w-0 truncate ${variant === "pill" ? "" : "flex-1"} ${selected ? "" : "text-faint"}`}>
          {triggerLabel}
        </span>
        <Chevron open={open} className={variant === "field" ? "pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2" : ""} />
      </button>
      {host &&
        createPortal(
          <div ref={popRef} className="group fixed left-0 top-0 z-[300]" data-side="bottom">
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              tabIndex={-1}
              aria-label={label}
              aria-activedescendant={cursor >= 0 ? optId(cursor) : undefined}
              onKeyDown={onListKey}
              onBlur={(e) => {
                const to = e.relatedTarget as Node | null;
                if (to && (popRef.current?.contains(to) || buttonRef.current?.contains(to))) return;
                if (to) close(false);
              }}
              className="hd-pop relative overflow-y-auto overscroll-contain rounded-[18px] border border-line bg-panel p-1.5 text-foreground shadow-pop outline-none"
            >
              {options.map((o, i) => {
                const isSelected = i === selectedIndex;
                const active = i === cursor;
                const second = secondLine(o);
                return (
                  <div
                    key={String(o.value)}
                    id={optId(i)}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={o.disabled || undefined}
                    onClick={() => pick(i)}
                    onPointerMove={() => {
                      if (!o.disabled && cursor !== i) setCursor(i);
                    }}
                    className={`flex w-full select-none items-center gap-2.5 rounded-xl px-2.5 text-left text-[14px] transition-colors duration-150 motion-reduce:transition-none ${
                      twoLine ? "min-h-[52px] py-1.5" : "min-h-11"
                    } ${o.disabled ? (o.badge ? "cursor-not-allowed text-mute" : "cursor-not-allowed opacity-45") : "cursor-pointer"} ${active && !o.disabled ? "bg-surface" : ""}`}
                  >
                    {o.icon && (
                      <span aria-hidden className="flex shrink-0">
                        {o.icon}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate leading-tight ${isSelected ? "font-medium" : ""}`}>{o.label}</span>
                      {second && <span className="mt-0.5 block truncate text-[12px] leading-tight text-mute">{second}</span>}
                    </span>
                    {o.badge && (
                      <span className="shrink-0 rounded-full border border-line-strong bg-accent-soft px-2 py-0.5 text-[11px] font-medium leading-none text-accent">{o.badge}</span>
                    )}
                    {isSelected && <Check />}
                  </div>
                );
              })}
            </div>
          </div>,
          host
        )}
    </>
  );
}
