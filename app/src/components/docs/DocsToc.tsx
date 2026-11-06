"use client";

import { usePathname } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { ListIcon, useDismiss } from "./docsUi";

export type TocHeading = { id: string; text: string };

/** Right rail: "On this page" with a bar that follows the section in view. */
export function OnThisPage({
  headings,
  activeId,
}: {
  headings: TocHeading[];
  activeId: string | null;
}) {
  if (headings.length < 2) return null;
  return (
    <nav aria-label="On this page">
      <p className="t-label flex items-center gap-2">
        <ListIcon size={13} className="text-faint" />
        On this page
      </p>
      <ul className="mt-4 border-l border-line">
        {headings.map((h) => {
          const on = h.id === activeId;
          return (
            <li key={h.id} className="relative">
              {on && (
                <span
                  aria-hidden
                  className="absolute -left-px top-1 bottom-1 w-[2px] rounded-full bg-foreground"
                />
              )}
              <a
                href={`#${h.id}`}
                aria-current={on ? "location" : undefined}
                className={`block py-[7px] pl-4 text-[13.5px] leading-snug transition-colors ${
                  on ? "text-foreground" : "text-mute hover:text-foreground"
                }`}
              >
                {h.text}
              </a>
            </li>
          );
        })}
      </ul>
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          window.scrollTo({ top: 0 });
          window.history.replaceState(null, "", window.location.pathname);
        }}
        className="mt-6 inline-flex items-center gap-1.5 text-[13px] text-mute transition-colors hover:text-foreground"
      >
        Back to top
        <span aria-hidden>↑</span>
      </a>
    </nav>
  );
}

/** Below xl: the same list in a small menu next to the Copy page button. */
export function TocMenu({
  headings,
  activeId,
}: {
  headings: TocHeading[];
  activeId: string | null;
}) {
  const pathname = usePathname();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === pathname;
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpenFor(null), []);
  useDismiss(ref, open, close);

  if (headings.length < 2) return null;

  return (
    <div ref={ref} className="relative xl:hidden">
      <button
        type="button"
        onClick={() => (open ? close() : setOpenFor(pathname))}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label="On this page"
        className={`grid h-10 w-10 place-items-center rounded-full border border-line lg:h-8 lg:w-8 text-mute transition-colors hover:bg-surface hover:text-foreground ${
          open ? "bg-surface text-foreground" : ""
        }`}
      >
        <ListIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 w-[min(300px,calc(100vw-32px))] rounded-2xl border border-line bg-panel p-1.5 shadow-pop transition-[opacity,transform] duration-150 starting:opacity-0 motion-safe:starting:-translate-y-1">
          <p className="t-label px-3 pb-1.5 pt-2.5">On this page</p>
          <ul className="max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain">
            {headings.map((h) => {
              const on = h.id === activeId;
              return (
                <li key={h.id}>
                  <a
                    href={`#${h.id}`}
                    onClick={close}
                    aria-current={on ? "location" : undefined}
                    className={`flex min-h-10 items-center rounded-xl px-3 py-2 text-[14px] leading-snug transition-colors hover:bg-surface ${
                      on ? "bg-surface font-medium text-foreground" : "text-soft"
                    }`}
                  >
                    {h.text}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
