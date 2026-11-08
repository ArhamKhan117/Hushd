import type { ReactNode } from "react";
import { Reveal } from "@/components/ui/Reveal";

/**
 * Step diagrams and callouts for the docs. Rendered inside `.docs-prose`, so
 * everything here is built from spans and divs: prose rules style bare p, li
 * and a tags, and these cards should not inherit them. Steps sit on one
 * hairline grid in a framed figure and rise in, in order, as it scrolls into view.
 */

export type FlowStep = {
  n: string;
  title: string;
  body: string;
};

function gridCols(n: number) {
  if (n <= 1) return "";
  if (n === 2 || n === 4) return "sm:grid-cols-2";
  return "sm:grid-cols-2 md:grid-cols-3";
}

function StepMark({ n }: { n: string }) {
  if (!/^\d+$/.test(n)) return <span className="docs-step-tag">{n}</span>;
  return (
    <span className="flex items-center gap-2.5">
      <span className="docs-step-n">{n}</span>
      <span className="docs-step-tag">Step</span>
    </span>
  );
}

export function FlowDiagram({ title, subtitle, steps }: { title: string; subtitle?: string; steps: FlowStep[] }) {
  const long = steps.length > 6;
  return (
    <figure className="docs-figure hd-frame my-10">
      <figcaption className="docs-figure-cap">
        <span className="t-label">{title}</span>
        {subtitle && <span className="text-[13.5px] leading-snug text-mute">{subtitle}</span>}
      </figcaption>
      {long ? (
        /* long boards read better as rows than as a wall of cards */
        <Reveal className="hd-grid-lines docs-steps grid" stagger={55}>
          {steps.map((s, i) => (
            <div key={`${s.n}-${i}`} data-reveal-item className="grid gap-3 px-5 py-4 sm:grid-cols-[104px_minmax(0,1fr)] sm:gap-5">
              <span className="block sm:pt-0.5">
                <StepMark n={s.n} />
              </span>
              <span className="block min-w-0">
                <span className="block text-[16px] leading-snug tracking-[-0.01em] text-foreground">{s.title}</span>
                <span className="mt-1 block text-[14px] leading-[1.55] text-mute">{s.body}</span>
              </span>
            </div>
          ))}
        </Reveal>
      ) : (
        <Reveal className={`hd-grid-lines docs-steps grid ${gridCols(steps.length)}`} stagger={80}>
          {steps.map((s, i) => (
            <div key={`${s.n}-${i}`} data-reveal-item className="docs-step">
              <StepMark n={s.n} />
              <span className="mt-5 block text-[16px] leading-snug tracking-[-0.01em] text-foreground">{s.title}</span>
              <span className="mt-1.5 block text-[14px] leading-[1.55] text-mute">{s.body}</span>
            </div>
          ))}
        </Reveal>
      )}
    </figure>
  );
}

function InfoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 11v5.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="7.9" r="1" fill="currentColor" />
    </svg>
  );
}

function CaveatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M10.4 4.6a1.85 1.85 0 0 1 3.2 0l7 12.2a1.85 1.85 0 0 1-1.6 2.7H5a1.85 1.85 0 0 1-1.6-2.7l7-12.2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M12 9.5v4.25" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="16.4" r="1" fill="currentColor" />
    </svg>
  );
}

/** A quiet aside in the reading column: a note, or a caveat that matters. A rule down its left edge and an icon. */
export function Callout({ tone = "note", title, children }: { tone?: "note" | "caveat"; title: string; children: ReactNode }) {
  return (
    <aside data-tone={tone} className="docs-callout my-8">
      <span className="docs-callout-icon">{tone === "caveat" ? <CaveatIcon /> : <InfoIcon />}</span>
      <span className="block min-w-0">
        <span className="block text-[14px] font-medium text-foreground">{title}</span>
        <span className="mt-1.5 block text-[14.5px] leading-[1.6] text-soft">{children}</span>
      </span>
    </aside>
  );
}

function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Who sees what, as two lists side by side: what anyone can read, and what stays sealed. */
export function SeenBy({ title, open, sealed }: { title: string; open: string[]; sealed: string[] }) {
  return (
    <figure className="docs-figure hd-frame my-10">
      <figcaption className="docs-figure-cap">
        <span className="t-label">{title}</span>
      </figcaption>
      <Reveal className="hd-grid-lines docs-steps grid sm:grid-cols-2" stagger={90}>
        <div data-reveal-item className="docs-step">
          <span className="flex items-center gap-2 text-[13px] text-mute">
            <EyeIcon />
            Anyone can read
          </span>
          <span className="mt-4 block space-y-2.5">
            {open.map((x) => (
              <span key={x} className="flex gap-2.5 text-[14.5px] leading-snug text-foreground">
                <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
                {x}
              </span>
            ))}
          </span>
        </div>
        <div data-reveal-item className="docs-step docs-step-sealed">
          <span className="flex items-center gap-2 text-[13px] font-medium text-sealed">
            <LockIcon />
            Stays private
          </span>
          <span className="mt-4 block space-y-2.5">
            {sealed.map((x) => (
              <span key={x} className="flex gap-2.5 text-[14.5px] leading-snug text-foreground">
                <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-sealed" />
                {x}
              </span>
            ))}
          </span>
        </div>
      </Reveal>
    </figure>
  );
}

/**
 * Inline code that may wrap after a dot, an underscore, a slash or an opening
 * bracket, so long account ids and tool names break at a seam in narrow table
 * cells instead of in the middle of a word. A run with no seam longer than 24
 * characters (a 64-hex implicit account) may also wrap every 16 characters.
 */
export function Code({ children }: { children: string }) {
  const parts = children.split(/(?<=[._/(])/).flatMap((p) => (p.length > 24 ? (p.match(/.{1,16}/g) ?? [p]) : [p]));
  return (
    <code>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && <wbr />}
        </span>
      ))}
    </code>
  );
}
