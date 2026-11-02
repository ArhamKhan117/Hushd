/** A sealed amount: a short row of dots in place of a number. */
export function SealDots({
  n = 6,
  className = "",
  label = "Amount hidden",
}: {
  n?: number;
  className?: string;
  label?: string;
}) {
  return (
    <span className={`seal-dots ${className}`} role="img" aria-label={label}>
      {Array.from({ length: n }).map((_, i) => (
        <i key={i} />
      ))}
    </span>
  );
}
