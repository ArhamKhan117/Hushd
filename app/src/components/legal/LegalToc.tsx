"use client";

import { useEffect, useState } from "react";

export type LegalSection = { id: string; text: string };

/** Scroll offset under the sticky site header, matching the headings' scroll margin. */
const SPY_OFFSET = 140;

/**
 * The contents rail beside a legal page: numbered like the sections, the one
 * in view marked by a steel rule on the track.
 */
export function LegalToc({ sections }: { sections: LegalSection[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((el): el is HTMLElement => el !== null);
    if (!els.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = els[0]!.id;
      for (const el of els) {
        if (el.getBoundingClientRect().top <= SPY_OFFSET) current = el.id;
        else break;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = els[els.length - 1]!.id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const boot = window.requestAnimationFrame(update);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.cancelAnimationFrame(boot);
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [sections]);

  if (sections.length < 2) return null;
  return (
    <nav aria-label="On this page" className="pg-toc">
      <p className="t-label">On this page</p>
      <ul className="pg-toc-list">
        {sections.map((s, i) => (
          <li key={s.id}>
            <a href={`#${s.id}`} aria-current={s.id === active ? "location" : undefined} className="pg-toc-link">
              <span aria-hidden>{String(i + 1).padStart(2, "0")}</span>
              <span>{s.text}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
