/**
 * The sealed field: Hushd's one luminous glow. Place inside a relative,
 * overflow-hidden box (`.hd-panel`). It is the brand surface and, in the app,
 * the signal that what sits on it is private.
 */
export function SealedField({
  tone = "full",
  drift = false,
  className = "",
}: {
  tone?: "full" | "soft" | "edge";
  drift?: boolean;
  className?: string;
}) {
  const base =
    tone === "soft" ? "hd-field-soft" : tone === "edge" ? "hd-field-edge" : "hd-field";
  return (
    <div
      aria-hidden
      className={`${base}${drift && tone === "full" ? " hd-drift" : ""} ${className}`}
    />
  );
}
