"use client";

import Link from "next/link";
import { useRef, type ElementType, type PointerEvent, type ReactNode } from "react";

/**
 * A surface lit from where the pointer is: a soft graphite light follows the cursor
 * inside it (`.hd-spot` in globals.css). Touch and keyboard users see the surface as
 * it is; nothing depends on the light.
 */
export function Spotlight({
  as,
  href,
  children,
  className = "",
  ...rest
}: { as?: ElementType; href?: string; children: ReactNode; className?: string } & Record<string, unknown>) {
  // a link is rendered here, since a server component cannot hand a component over
  const Tag: ElementType = href ? Link : (as ?? "div");
  const ref = useRef<HTMLElement>(null);
  const move = (e: PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse") return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <Tag ref={ref} href={href} onPointerMove={move} className={`hd-spot ${className}`} {...rest}>
      {children}
    </Tag>
  );
}
