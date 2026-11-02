/**
 * The "opens elsewhere" arrow, drawn instead of the ↗ character so it never
 * turns into an emoji. Sized to the text around it and drawn in currentColor.
 */
export function ArrowUpRight({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      className={`inline-block h-[0.8em] w-[0.8em] shrink-0 ${className}`}
    >
      <path
        d="M4.75 11.25l6.5-6.5M5.75 4.75h5.5v5.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
