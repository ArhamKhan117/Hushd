import type { ReactNode } from "react";

/** Help that is there when wanted: a small disclosure, collapsed by default, in short bullet lines. */
export function HowItWorks({ title = "How it works", items, className = "mt-2" }: { title?: string; items: ReactNode[]; className?: string }) {
  return (
    <details className={`text-[12.5px] text-mute ${className}`}>
      <summary className="w-fit cursor-pointer select-none underline decoration-line-strong underline-offset-4 hover:text-foreground">{title}</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </details>
  );
}
