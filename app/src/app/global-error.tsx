"use client";

import { useEffect } from "react";
import { Mark } from "@/components/Logo";
import { THEME_BOOT_SCRIPT, THEME_KEY } from "@/lib/theme";
import "./globals.css";

/**
 * Last-resort error screen, shown only when the root layout itself fails. It
 * replaces the whole document, so it carries its own html, theme and styles,
 * and links out with plain anchors instead of the router.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // On a client-side failure the head script does not run again; restamp the theme.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      const dark =
        saved === "dark" ||
        (saved !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const d = document.documentElement;
      d.dataset.theme = dark ? "dark" : "light";
      d.classList.toggle("dark", dark);
      d.classList.toggle("light", !dark);
    } catch {
      /* storage unavailable: stay light */
    }
  }, []);

  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <title>Something went wrong · Hushd</title>
        <meta name="robots" content="noindex" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body
        className="flex min-h-full flex-col bg-panel text-foreground"
        style={{ fontFamily: '"Geist", system-ui, sans-serif' }}
      >
        <header className="mx-auto flex h-16 w-full max-w-[1400px] items-center px-4 sm:px-7">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain links: the router may be what failed */}
          <a href="/" aria-label="Hushd home" className="inline-flex items-center gap-2.5">
            <Mark size={26} />
            <span className="text-[19px] font-medium leading-none tracking-[-0.015em] text-foreground">
              Hushd
            </span>
          </a>
        </header>
        <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 pb-4 pt-3 sm:px-7 sm:pb-7 sm:pt-6">
          <div className="hd-panel flex min-h-[calc(100svh-5rem)] flex-1 flex-col justify-end px-6 pb-10 pt-24 sm:px-12 sm:pb-14">
            <div aria-hidden className="hd-field" />
            <div className="relative max-w-[760px]">
              <p className="t-label">Something went wrong</p>
              <h1 className="t-display-xl mt-5">Hushd could not load</h1>
              <p className="mt-6 max-w-[46ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                It is on our side, not yours. Try again in a moment. If it keeps
                happening, write to{" "}
                <a
                  href="mailto:hello@hushd.net"
                  className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
                >
                  hello@hushd.net
                </a>
                .
              </p>
              <div className="mt-8 flex flex-wrap gap-2">
                <button type="button" onClick={() => unstable_retry()} className="btn btn-ink btn-lg">
                  Try again
                </button>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- plain links: the router may be what failed */}
                <a href="/" className="btn btn-ghost btn-lg">
                  Back to home
                </a>
              </div>
              {error.digest && (
                <p className="tnum mt-6 text-[12.5px] text-faint">Reference {error.digest}</p>
              )}
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
