export const CONSENT_KEY = "hushd_cookie_consent";
export type ConsentValue = "all" | "essential";

export function getConsent(): ConsentValue | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v === "all" || v === "essential") return v;
    return null;
  } catch {
    return null;
  }
}

export function setConsent(value: ConsentValue): void {
  try {
    localStorage.setItem(CONSENT_KEY, value);
    window.dispatchEvent(
      new CustomEvent("hushd-consent", { detail: value })
    );
  } catch {
    /* private mode */
  }
}

/** Calls back when the choice changes, in this tab (setConsent) or another one. */
export function subscribeConsent(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener("hushd-consent", onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener("hushd-consent", onChange);
  };
}

/** Optional analytics only when user chose "all". */
export function analyticsAllowed(): boolean {
  return getConsent() === "all";
}
