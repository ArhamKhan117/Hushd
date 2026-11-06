import type { ReactNode } from "react";

/**
 * Step diagrams and callouts for the docs. Rendered inside `.docs-prose`, so
 * everything here is built from spans and divs: prose rules style bare p, li
 * and a tags, and these cards should not inherit them.
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

export function FlowDiagram({ title, subtitle, steps }: { title: string; subtitle?: string; steps: FlowStep[] }) {
  return (
    <figure className="my-10 rounded-[22px] border border-line p-2 sm:p-2.5">
      <figcaption className="flex flex-col gap-1 px-3 pb-3.5 pt-3 sm:px-3.5">
        <span className="t-label">{title}</span>
        {subtitle && <span className="text-[13.5px] leading-snug text-mute">{subtitle}</span>}
      </figcaption>
      {steps.length > 6 ? (
        /* long boards read better as rows than as a wall of cards */
        <div className="hd-tile divide-y divide-line">
          {steps.map((s, i) => (
            <div key={`${s.n}-${i}`} className="grid gap-3 px-5 py-4 sm:grid-cols-[104px_minmax(0,1fr)] sm:gap-5">
              <span className="t-label tnum block sm:pt-0.5">{/^\d+$/.test(s.n) ? `Step ${s.n}` : s.n}</span>
              <span className="block min-w-0">
                <span className="block text-[16px] leading-snug tracking-[-0.01em] text-foreground">{s.title}</span>
                <span className="mt-1 block text-[14px] leading-[1.55] text-mute">{s.body}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={`grid gap-2 ${gridCols(steps.length)}`}>
          {steps.map((s, i) => (
            <div key={`${s.n}-${i}`} className="hd-tile flex flex-col p-5">
              <span className="t-label tnum block">{/^\d+$/.test(s.n) ? `Step ${s.n}` : s.n}</span>
              <span className="mt-4 block text-[16px] leading-snug tracking-[-0.01em] text-foreground">{s.title}</span>
              <span className="mt-1.5 block text-[14px] leading-[1.55] text-mute">{s.body}</span>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

/** A quiet aside in the reading column: a note, or a caveat that matters. */
export function Callout({ tone = "note", title, children }: { tone?: "note" | "caveat"; title: string; children: ReactNode }) {
  return (
    <aside className={`my-8 rounded-[18px] px-5 py-4 sm:px-6 sm:py-5 ${tone === "caveat" ? "bg-warn-soft" : "bg-surface"}`}>
      <span className={`block text-[14px] font-medium ${tone === "caveat" ? "text-warn" : "text-foreground"}`}>{title}</span>
      <span className="mt-1.5 block text-[14.5px] leading-[1.6] text-soft">{children}</span>
    </aside>
  );
}

/** Who sees what, as two lists side by side: what anyone can read, and what stays sealed. */
export function SeenBy({ title, open, sealed }: { title: string; open: string[]; sealed: string[] }) {
  return (
    <figure className="my-10 rounded-[22px] border border-line p-2 sm:p-2.5">
      <figcaption className="px-3 pb-3.5 pt-3 sm:px-3.5">
        <span className="t-label">{title}</span>
      </figcaption>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="hd-tile p-5">
          <span className="block text-[13px] text-mute">Anyone can read</span>
          <span className="mt-3 block space-y-2">
            {open.map((x) => (
              <span key={x} className="flex gap-2.5 text-[14.5px] leading-snug text-foreground">
                <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
                {x}
              </span>
            ))}
          </span>
        </div>
        <div className="hd-tile bg-sealed-soft p-5">
          <span className="block text-[13px] font-medium text-sealed">Stays private</span>
          <span className="mt-3 block space-y-2">
            {sealed.map((x) => (
              <span key={x} className="flex gap-2.5 text-[14.5px] leading-snug text-foreground">
                <span aria-hidden className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-sealed" />
                {x}
              </span>
            ))}
          </span>
        </div>
      </div>
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
