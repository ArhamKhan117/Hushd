"use client";

import {
  motion,
  useReducedMotion,
  type Variants,
} from "framer-motion";
import type { ReactNode } from "react";

const ease = [0.22, 1, 0.36, 1] as const;

export function useMotionSafe() {
  const reduce = useReducedMotion();
  return !reduce;
}

/** Subtle entrance, never leave long opacity-0 voids on scroll. */
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.35, ease } },
};

export const stagger: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06, delayChildren: 0.04 },
  },
};

/**
 * Section wrapper. Plain <section> so content is never stuck at opacity 0.
 * Children reveal via MotionItem / MotionCard whileInView.
 */
export function MotionSection({
  children,
  className = "",
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  /** @deprecated ignored, kept for call-site compatibility */
  delay?: number;
}) {
  return (
    <section id={id} className={className}>
      {children}
    </section>
  );
}

const viewport = { once: true, amount: 0.15, margin: "0px 0px -40px 0px" } as const;

export function MotionItem({
  children,
  className = "",
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "article" | "li" | "p" | "h1" | "h2" | "h3";
}) {
  const animate = useMotionSafe();
  const Comp = motion[as];
  if (!animate) {
    return <div className={className}>{children}</div>;
  }
  return (
    <Comp
      className={className}
      variants={fadeUp}
      initial="hidden"
      whileInView="show"
      viewport={viewport}
    >
      {children}
    </Comp>
  );
}

export function MotionCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const animate = useMotionSafe();
  if (!animate) {
    return <article className={className}>{children}</article>;
  }
  return (
    <motion.article
      className={className}
      variants={fadeUp}
      initial="hidden"
      whileInView="show"
      viewport={viewport}
      whileHover={{ y: -3, transition: { duration: 0.2, ease } }}
      whileTap={{ scale: 0.99 }}
    >
      {children}
    </motion.article>
  );
}

export function MotionPress({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  const animate = useMotionSafe();
  return (
    <motion.div
      className={className}
      whileHover={animate ? { scale: 1.02 } : undefined}
      whileTap={animate ? { scale: 0.98 } : undefined}
      transition={{ type: "spring", stiffness: 420, damping: 28 }}
    >
      {children}
    </motion.div>
  );
}
