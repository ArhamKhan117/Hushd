"use client";

import { useEffect, useState } from "react";
import { SealDots } from "@/components/ui/SealDots";

const STAGES = [
  { title: "Sealed request", note: "Your limit goes to the enclave only. The chain gets a hash." },
  { title: "Matched in the enclave", note: "The best quote inside your limit wins. Losing quotes never leave." },
  { title: "Settled in one call", note: "Both legs, proven privately, in one pool call: both or neither." },
  { title: "Receipt on chain", note: "The maker and the outcome on the record. Who and how much, not." },
];

/**
 * The hero's picture of one deal: four stages that light in turn, once, when the
 * page opens. Words and sealed dots only; no figures, since none would be real.
 */
export function HeroDeal() {
  const [lit, setLit] = useState(STAGES.length);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timers: number[] = [];
    // start dark, then light each stage in turn
    timers.push(window.setTimeout(() => setLit(0), 0));
    STAGES.forEach((_, i) => timers.push(window.setTimeout(() => setLit(i + 1), 650 + i * 750)));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);

  return (
    <div className="hd-glass hd-sheen relative w-full max-w-[400px] p-2">
      <div className="rounded-[12px] bg-panel p-5">
        <div className="flex items-center justify-between gap-3 border-b border-line pb-4">
          <div>
            <p className="t-label">A request</p>
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-foreground">
              Sell <SealDots n={4} className="text-foreground/70" label="An amount, sealed" /> USDC for BTC
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-line px-2.5 py-1 text-[11.5px] text-mute">Sealed</span>
        </div>
        <ol className="relative mt-4">
          {/* the rail fills as stages light */}
          <span aria-hidden className="absolute bottom-3 left-[4px] top-3 w-px bg-line" />
          <span
            aria-hidden
            className="hd-stage-rail absolute bottom-3 left-[4px] top-3 w-px bg-foreground"
            style={{ transform: `scaleY(${Math.max(0, (lit - 1) / (STAGES.length - 1))})` }}
          />
          {STAGES.map((s, i) => (
            <li key={s.title} className="hd-stage relative flex gap-4 py-2.5" data-lit={i < lit}>
              <span className="hd-stage-dot relative z-10 mt-[5px] shrink-0" />
              <span>
                <span className="block text-[14.5px] leading-snug text-foreground">{s.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-mute">{s.note}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
