"use client";

import { useState } from "react";

/** A copyable shell command in the brand font. No monospace, no overflow, tokens only. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy command: ${command}`}
      className="group flex min-h-12 w-full min-w-0 items-center gap-3 rounded-xl border border-line bg-panel py-1.5 pl-3.5 pr-1 text-left text-[13.5px] text-foreground sm:pl-4 sm:pr-1.5 transition-colors hover:border-line-strong sm:text-[14.5px]"
    >
      <span aria-hidden className="select-none text-faint max-sm:hidden">
        $
      </span>
      <span className="tnum min-w-0 flex-1 py-1 leading-snug [overflow-wrap:anywhere]">{command}</span>
      <span
        className={`hd-tap inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2 text-[12.5px] sm:px-2.5 font-medium transition-colors ${
          copied
            ? "text-foreground"
            : "text-mute group-hover:bg-surface group-hover:text-foreground"
        }`}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M5 12.5l4.2 4.2L19 7"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"
              stroke="currentColor"
              strokeWidth="1.5"
            />
          </svg>
        )}
        <span aria-live="polite" className="max-sm:sr-only">
          {copied ? "Copied" : "Copy"}
        </span>
      </span>
    </button>
  );
}
