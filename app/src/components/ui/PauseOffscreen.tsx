"use client";

import { useEffect, useRef, type HTMLAttributes } from "react";

/**
 * A div that marks itself `data-paused` while it is off screen, so CSS
 * animations inside can stop (`[data-paused] .x { animation-play-state: paused }`).
 */
export function PauseOffscreen(props: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      el.toggleAttribute("data-paused", !e?.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return <div ref={ref} {...props} />;
}
