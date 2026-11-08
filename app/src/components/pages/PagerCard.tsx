"use client";

import Link from "next/link";
import { Spotlight } from "@/components/ui/Spotlight";

/**
 * Previous or next, as a framed card lit from where the pointer is. Used at
 * the foot of each docs page and each legal page. Styles in styles/pages.css.
 */
export function PagerCard({
  href,
  label,
  group,
  n,
  dir,
}: {
  href: string;
  label: string;
  /** The set it belongs to, shown with its number (e.g. "02", "The desk"). */
  group: string;
  n: string;
  dir: "prev" | "next";
}) {
  const next = dir === "next";
  return (
    <div className="hd-frame rounded-[16px] border-transparent">
      <Spotlight as={Link} href={href} data-dir={dir} className="pg-card pg-pager h-full">
        <span className="pg-pager-dir">
          {!next && (
            <span aria-hidden className="pg-pager-arrow">
              ←
            </span>
          )}
          {next ? "Next" : "Previous"}
          {next && (
            <span aria-hidden className="pg-pager-arrow">
              →
            </span>
          )}
        </span>
        <span className="flex flex-col gap-1.5">
          {n ? (
            <span className="hd-index" data-n={n}>
              <i />
              {group}
            </span>
          ) : (
            <span className="text-[12px] text-mute">{group}</span>
          )}
          <span className="pg-pager-title">{label}</span>
        </span>
      </Spotlight>
    </div>
  );
}
