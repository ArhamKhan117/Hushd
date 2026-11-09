"use client";

import { useEffect, useRef } from "react";

const LETTERS = ["H", "U", "S", "H", "D"];

/**
 * The name across the foot of every public page, cut by the page's own edge. It rises
 * into place, one letter after another, the first time it scrolls into view.
 */
export function FooterWordmark() {
  const ref = useRef<HTMLDivElement>(null);

  // the word shows as it is until the browser can watch for it (no script, reduced motion);
  // then it waits below the edge ("armed") and rises once it scrolls into view ("in")
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.dataset.state = "armed";
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          el.dataset.state = "in";
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} aria-hidden className="hd-wordmark">
      <div className="hd-wordmark-clip">
        <div className="hd-wordmark-glow" />
        <p className="hd-wordmark-word">
          {LETTERS.map((l, i) => (
            <span key={i} style={{ "--i": i } as React.CSSProperties}>
              {l}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
