"use client";

import { useEffect, useRef, type ElementType, type ReactNode } from "react";

/**
 * Content that rises into place the first time it scrolls into view, with the same
 * curve as the footer wordmark. Children marked `data-reveal-item` follow one after
 * another (`stagger` ms apart). Without script, or with reduced motion, it simply shows.
 */
export function Reveal({
  as: Tag = "div",
  children,
  className = "",
  stagger = 70,
  threshold = 0.18,
}: {
  as?: ElementType;
  children: ReactNode;
  className?: string;
  stagger?: number;
  threshold?: number;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.querySelectorAll<HTMLElement>("[data-reveal-item]").forEach((item, i) => item.style.setProperty("--reveal-i", String(i)));
    el.style.setProperty("--reveal-stagger", `${stagger}ms`);
    // already on screen when the page opens: no rise, it is simply there
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.9 && r.bottom > 0) return;
    el.dataset.reveal = "armed";
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) {
          el.dataset.reveal = "in";
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [stagger, threshold]);

  return (
    <Tag ref={ref} className={`hd-reveal ${className}`}>
      {children}
    </Tag>
  );
}
