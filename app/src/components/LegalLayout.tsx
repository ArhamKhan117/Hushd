import Link from "next/link";
import type { ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";

const DOCS = [
  { href: "/terms", label: "Terms of use", title: "Terms of use" },
  { href: "/privacy", label: "Privacy", title: "Privacy" },
  { href: "/cookies", label: "Cookies and storage", title: "Cookies and storage" },
  { href: "/security", label: "Security", title: "Security" },
];

/**
 * Shared shell for the legal pages: the marketing header and footer around a
 * calm reading column. Typography comes from `.prose-legal` in globals.
 */
export function LegalLayout({
  title,
  label = "Legal",
  updated,
  lede,
  children,
}: {
  title: string;
  label?: string;
  updated: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-panel text-foreground">
      <Header />

      <main id="main" className="mx-auto max-w-[1240px] px-6 pb-8 pt-12 sm:pt-20">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-20">
          {/* document switcher: a rail on desktop, wrapping chips on mobile */}
          <nav aria-label="Legal documents" className="min-w-0">
            <div className="lg:sticky lg:top-24">
              <p className="t-label max-lg:hidden">Documents</p>
              <ul className="flex flex-wrap gap-1.5 lg:mt-5 lg:flex-col lg:flex-nowrap lg:gap-0.5">
                {DOCS.map((d) => {
                  const active = d.title === title;
                  return (
                    <li key={d.href} className="shrink-0">
                      <Link
                        href={d.href}
                        aria-current={active ? "page" : undefined}
                        className={`flex h-10 items-center rounded-full px-4 text-[14px] transition-colors lg:rounded-xl lg:px-3 ${
                          active ? "bg-surface font-medium text-foreground" : "text-mute hover:bg-surface hover:text-foreground"
                        }`}
                      >
                        {d.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </nav>

          <article className="min-w-0 max-w-[68ch]">
            <p className="t-label">{label}</p>
            <h1 className="t-display-l mt-4">{title}</h1>
            {lede && <p className="mt-5 max-w-[56ch] text-[17px] leading-relaxed text-soft">{lede}</p>}
            <p className="mt-5 text-[14px] text-mute">Last updated {updated}</p>

            <div className="prose-legal mt-12 space-y-5 border-t border-line pt-10 text-[15.5px] leading-[1.75] text-soft [overflow-wrap:anywhere] [&_code]:rounded-md [&_code]:bg-surface [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.92em] [&_code]:text-foreground [&_h2]:mt-12! [&>h2:first-child]:mt-0! [&_h2]:text-[24px]! [&_h2]:leading-snug [&_h2]:tracking-[-0.015em] [&_li+li]:mt-2">
              {children}
            </div>

            <div className="mt-16 border-t border-line pt-6">
              <Link href="/" className="hd-arrowlink">
                <span aria-hidden>←</span> Back to home
              </Link>
            </div>
          </article>
        </div>
      </main>

      <Footer />
    </div>
  );
}
