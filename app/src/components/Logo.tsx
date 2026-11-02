import Link from "next/link";

/** The Hushd mark: an ink tile with two redaction bars. */
export function Mark({
  size = 24,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      <rect width="32" height="32" rx="10" fill="var(--foreground)" />
      <rect x="7" y="11" width="18" height="4.5" rx="2.25" fill="var(--background)" />
      <rect x="7" y="18" width="11" height="4.5" rx="2.25" fill="var(--background)" />
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
      className={`hd-tap inline-flex items-center gap-2.5 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${className}`}
    >
      <Mark size={size} />
      <span className="text-[19px] font-medium leading-none tracking-[-0.015em] text-foreground">
        Hushd
      </span>
    </Link>
  );
}
