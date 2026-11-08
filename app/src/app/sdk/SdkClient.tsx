"use client";

import { useId, useRef, useState } from "react";
import { Highlighted } from "@/components/ui/CodeBlock";
import { tabKeyTarget } from "@/lib/tabKeys";

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export type CodeTab = { id: string; label: string; file: string; code: string; lang?: "ts" | "json" | "bash" };

/** Tabbed code card for the developer panel. Lives inside a `theme-dark` panel. */
export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const [copied, setCopied] = useState(false);
  const base = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const index = Math.max(0, tabs.findIndex((t) => t.id === active));
  const tab = tabs[index];
  if (!tab) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(tab.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    const next = tabKeyTarget(e.key, index, tabs.length);
    if (next === null) return;
    e.preventDefault();
    setActive(tabs[next]!.id);
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="hd-frame rounded-[18px] border-transparent">
      <div className="overflow-hidden rounded-[18px] border border-line bg-panel shadow-[inset_0_1px_0_var(--pg-rim),var(--pg-drop)]">
        <div className="flex items-center justify-between gap-3 border-b border-line bg-[linear-gradient(180deg,var(--pg-card-top),var(--surface))] px-2 py-2">
          <div ref={listRef} role="tablist" aria-label="Code examples" onKeyDown={onKey} className="flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none]">
            {tabs.map((t) => {
              const on = t.id === tab.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`${base}-tab-${t.id}`}
                  aria-selected={on}
                  aria-controls={`${base}-panel`}
                  tabIndex={on ? 0 : -1}
                  onClick={() => setActive(t.id)}
                  className={`h-9 shrink-0 rounded-lg border px-3 text-[13px] transition-colors sm:px-3.5 ${on ? "border-line bg-panel text-foreground shadow-[inset_0_1px_0_var(--pg-rim)]" : "border-transparent text-mute hover:text-foreground"}`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={copied ? "Copied" : "Copy code"}
            className="hd-tap inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium text-mute transition-colors hover:bg-panel hover:text-foreground sm:px-3"
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span aria-live="polite" className="max-sm:sr-only">
              {copied ? "Copied" : "Copy"}
            </span>
          </button>
        </div>
        <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-tab-${tab.id}`} tabIndex={0} className="focus-visible:outline-offset-[-2px]">
          <pre className="tnum overflow-x-auto px-5 py-5 text-[13px] leading-[1.8] text-soft [tab-size:1.5em] sm:px-6 sm:text-[13.5px]">
            <Highlighted code={tab.code} lang={tab.lang ?? "ts"} />
          </pre>
        </div>
        <div className="flex items-center justify-between border-t border-line px-5 py-3 text-[12px] text-mute sm:px-6">
          <span className="inline-flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M7 3.75h6.5L18.25 8.5v10.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-13.5a1.5 1.5 0 0 1 1.5-1.5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M13.25 4v4.5h4.5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
            {tab.file}
          </span>
          <span>{tab.lang === "json" ? "JSON" : tab.lang === "bash" ? "Shell" : "TypeScript"}</span>
        </div>
      </div>
    </div>
  );
}
