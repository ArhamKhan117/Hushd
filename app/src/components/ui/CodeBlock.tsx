"use client";

import { useMemo, useState } from "react";
import { highlight, type CodeLang } from "@/lib/highlight";

/** Geist is proportional, so leading spaces become tabs with a fixed tab size. */
export function tabIndent(code: string): string {
  return code.replace(/^( {2})+/gm, (m) => "\t".repeat(m.length / 2));
}

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

/** A copy button that confirms for a moment. */
export function CopyButton({ text, className = "", label = "Copy code" }: { text: string; className?: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      className={`hd-tap inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-mute transition-colors hover:bg-surface-2 hover:text-foreground ${className}`}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

/** Highlighted code, theme-aware. `html` is escaped by the highlighter. */
export function Highlighted({ code, lang }: { code: string; lang?: CodeLang }) {
  const html = useMemo(() => highlight(tabIndent(code), lang), [code, lang]);
  return <code dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A titled, coloured, copyable code block. */
export function CodeBlock({
  code,
  lang,
  title,
  meta,
  className = "",
}: {
  code: string;
  lang?: CodeLang;
  title?: string;
  meta?: string;
  className?: string;
}) {
  return (
    <div className={`overflow-hidden rounded-[16px] border border-line bg-panel ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line py-1.5 pl-5 pr-2 text-[12.5px] text-mute">
        <span className="min-w-0 truncate">{title}</span>
        <span className="flex items-center gap-2">
          {meta && <span className="max-sm:hidden">{meta}</span>}
          <CopyButton text={code} />
        </span>
      </div>
      <pre className="tnum overflow-x-auto px-5 py-4 text-[13px] leading-[1.8] text-soft [tab-size:1.5em] sm:text-[13.5px]">
        <Highlighted code={code} lang={lang} />
      </pre>
    </div>
  );
}
