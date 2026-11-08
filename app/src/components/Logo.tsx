import Link from "next/link";

/**
 * The Hushd mark: a coin cut on a slant, its two halves slid past each other along
 * the cut. Two parties, one settlement, nothing showing through the seam. Ink and
 * steel, flat (no gloss), so it reads the same on paper and on ink. The paths and
 * the tile live here and in public/favicon.svg; scripts/make-icons.mjs rasterises them.
 */
export const MARK_TOP = "M5.1 15.2H23.1Q24.3 15.2 24.3 14A10.2 10.2 0 0 0 3.9 14Q3.9 15.2 5.1 15.2Z";
export const MARK_BOTTOM = "M8.9 16.8H26.9Q28.1 16.8 28.1 18A10.2 10.2 0 0 1 7.7 18Q7.7 16.8 8.9 16.8Z";
export const MARK_TURN = "rotate(-35 16 16)";

export function Mark({
  size = 24,
  className = "",
  tile = false,
}: {
  size?: number;
  className?: string;
  /** On an ink tile, for app icons and small places that need a ground of their own. */
  tile?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={`shrink-0 ${className}`}>
      {tile ? (
        <>
          <rect width="32" height="32" rx="8" fill="var(--foreground)" />
          <g transform={`translate(16 16) scale(0.78) translate(-16 -16) ${MARK_TURN}`}>
            <path d={MARK_TOP} fill="var(--background)" />
            <path d={MARK_BOTTOM} fill="var(--mark-tile-2)" />
          </g>
        </>
      ) : (
        <g transform={MARK_TURN}>
          <path d={MARK_TOP} fill="var(--foreground)" />
          <path d={MARK_BOTTOM} fill="var(--mark-2)" />
        </g>
      )}
    </svg>
  );
}

/** Hushd wordmark: mark + name. */
export function Logo({
  className = "",
  href = "/",
  size = 26,
}: {
  className?: string;
  href?: string;
  size?: number;
}) {
  return (
    <Link
      href={href}
      aria-label="Hushd home"
      className={`hd-tap group inline-flex items-center gap-2 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${className}`}
    >
      <Mark size={size} className="hd-mark-hover" />
      <span className="text-[19px] font-medium leading-none tracking-[-0.015em] text-foreground">
        Hushd
      </span>
    </Link>
  );
}
