/**
 * Where a key moves focus in a row of tabs (the WAI-ARIA tabs pattern): Left
 * and Right step to the next tab and wrap around, Home and End go to the first
 * and last. Null for every other key, which the tab handles as a button
 * (Enter or Space picks it).
 */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
