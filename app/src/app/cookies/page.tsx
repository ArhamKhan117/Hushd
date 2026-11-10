import type { Metadata } from "next";
import Link from "next/link";
import { CookiePreferences } from "@/components/CookiePreferences";
import { LegalLayout } from "@/components/LegalLayout";
import { CONSENT_KEY } from "@/lib/consent";
import { THEME_KEY } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Cookies and storage",
  description:
    "Hushd sets no ad or tracking cookies. What it keeps in your browser to work, and the one optional extra: cookieless page view counts if you choose Accept all.",
  alternates: { canonical: "/cookies" },
};

export default function CookiesPage() {
  return (
    <LegalLayout
      title="Cookies and storage"
      updated="6 November 2026"
      lede="Hushd sets no ad or tracking cookies. It keeps a few things in your browser so it can work, and counts page views only if you say yes."
    >
      <h2>Your choice</h2>
      <p>
        <strong>Essential only</strong> keeps what the site needs and nothing else. <strong>Accept all</strong> also
        turns on anonymous page view counts. Until you choose, the site works as Essential only.
      </p>
      <CookiePreferences />

      <h2>What Hushd keeps in your browser</h2>
      <p>These live in your browser&apos;s local storage, not in cookies, and never leave your device:</p>
      <ul>
        <li>
          <code>{CONSENT_KEY}</code>: your choice on this page.
        </li>
        <li>
          <code>{THEME_KEY}</code>: dark or auto, if you picked one (light is the default and stores nothing).
        </li>
        <li>
          <code>hushd.passkey.account</code>: which account your passkey opens, if you use one.
        </li>
        <li>Your notes, encrypted with a key from your seed, once you open your private balance.</li>
      </ul>
      <p>
        The wallet connector you choose in NEAR Connect may keep its own entries, such as which wallet you last used.
      </p>

      <h2>With Accept all</h2>
      <p>
        Vercel Web Analytics counts page views without cookies. Before anything is sent, the address is cut to its
        path, so nothing after a <code>?</code> or <code>#</code> leaves your browser. More in{" "}
        <Link href="/privacy">privacy</Link>.
      </p>

      <h2>Clearing it</h2>
      <p>
        Clearing this site&apos;s data in your browser removes all of the above. Your private balance is not lost: your
        seed recovers it from the board.
      </p>
    </LegalLayout>
  );
}
