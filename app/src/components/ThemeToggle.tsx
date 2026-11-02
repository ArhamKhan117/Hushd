"use client";

import { useTheme, type ThemeChoice } from "./ThemeProvider";

/** Compact light/dark switch for nav bars. A half-filled disc, not a sun and moon. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={`grid h-9 w-9 place-items-center rounded-full text-foreground transition-colors hover:bg-surface ${className}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 3.75a8.25 8.25 0 0 1 0 16.5z" fill="currentColor" />
      </svg>
    </button>
  );
}

const OPTIONS: { k: ThemeChoice; label: string }[] = [
  { k: "light", label: "Light" },
  { k: "dark", label: "Dark" },
  { k: "system", label: "Auto" },
];

/** Three-way appearance control for footers and Settings. */
export function ThemeSegmented({ className = "" }: { className?: string }) {
  const { choice, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className={`inline-flex rounded-full bg-surface p-1 text-[12.5px] ${className}`}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.k}
          type="button"
          role="radio"
          aria-checked={choice === o.k}
          onClick={() => setTheme(o.k)}
          className={`hd-tap h-8 rounded-full px-3.5 transition-colors ${
            choice === o.k
              ? "bg-panel text-foreground shadow-card"
              : "text-mute hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
