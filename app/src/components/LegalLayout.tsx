import Link from "next/link";
import { Children, cloneElement, isValidElement, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { Footer } from "@/components/Footer";
import { Header } from "@/components/Header";
import { LegalToc, type LegalSection } from "@/components/legal/LegalToc";
import { PagerCard } from "@/components/pages/PagerCard";

const DOCS = [
  { href: "/terms", label: "Terms of use", title: "Terms of use", group: "Legal" },
  { href: "/privacy", label: "Privacy", title: "Privacy", group: "Legal" },
  { href: "/cookies", label: "Cookies and storage", title: "Cookies and storage", group: "Legal" },
  { href: "/security", label: "Security", title: "Security", group: "Trust" },
];

const two = (n: number) => String(n).padStart(2, "0");
const rise = (d: number) => ({ "--d": d }) as CSSProperties;

/** The plain text of a node, for a heading's id and its line in the contents. */
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function slug(text: string) {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Gives each top-level h2 an id (on the server, so links work without script) and lists them. */
function withSectionIds(children: ReactNode): { body: ReactNode[]; sections: LegalSection[] } {
  const sections: LegalSection[] = [];
  const body = Children.toArray(children).map((child) => {
    if (!isValidElement(child) || child.type !== "h2") return child;
    const h = child as ReactElement<{ id?: string; children?: ReactNode }>;
    const text = textOf(h.props.children).trim();
    const id = h.props.id ?? (slug(text) || `section-${sections.length + 1}`);
    sections.push({ id, text });
    return cloneElement(h, { id });
  });
  return { body, sections };
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="4" y="5.5" width="16" height="14.5" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Layout for the privacy, terms, security and cookies pages. A lit header band
 * with the document switcher along its foot, then numbered sections with a
 * contents rail beside them. Text styles live in `.pg-legal` (styles/pages.css).
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
  const index = DOCS.findIndex((d) => d.title === title);
  const prev = index > 0 ? DOCS[index - 1] : undefined;
  const next = index >= 0 && index < DOCS.length - 1 ? DOCS[index + 1] : undefined;
  const { body, sections } = withSectionIds(children);

  return (
    <div className="min-h-screen bg-panel text-foreground">
      <Header />

      <main id="main" className="mx-auto max-w-[1240px] px-4 pb-8 pt-6 sm:px-6 sm:pt-10">
        <header className="pg-band hd-crop">
          <div className="pg-band-light" aria-hidden />
          <div className="px-5 pb-8 pt-5 sm:px-10 sm:pb-10 sm:pt-7 lg:px-12">
            <div className="flex items-center justify-between gap-4">
              <nav aria-label="Breadcrumb" className="pg-crumbs pg-rise">
                <span>{label}</span>
                <span data-sep aria-hidden>
                  /
                </span>
                <span aria-current="page">{title}</span>
              </nav>
              {index >= 0 && (
                <span className="pg-count pg-rise" aria-label={`Document ${index + 1} of ${DOCS.length}`}>
                  <b>{two(index + 1)}</b> / {two(DOCS.length)}
                </span>
              )}
            </div>
            <h1 style={rise(1)} className="t-display-l pg-rise mt-10 sm:mt-14">
              {title}
            </h1>
            {lede && (
              <p style={rise(2)} className="pg-rise mt-5 max-w-[56ch] text-[16.5px] leading-relaxed text-soft sm:text-[17px]">
                {lede}
              </p>
            )}
            <p style={rise(3)} className="pg-meta pg-rise mt-6">
              <CalendarIcon />
              Last updated {updated}
            </p>
          </div>

          {/* the document switcher: a 2 by 2 grid on phones, tabs from 640px */}
          <nav aria-label="Legal documents" className="pg-tabs">
            {DOCS.map((d, i) => (
              <Link key={d.href} href={d.href} aria-current={d.title === title ? "page" : undefined} className="pg-tab">
                <span className="pg-tab-n">{two(i + 1)}</span>
                <span className="min-w-0 leading-snug sm:whitespace-nowrap">{d.label}</span>
              </Link>
            ))}
          </nav>
        </header>

        <div className="mt-12 grid grid-cols-1 gap-10 sm:mt-16 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-20">
          <aside className="min-w-0 max-lg:hidden">
            <div className="lg:sticky lg:top-24">
              <LegalToc sections={sections} />
            </div>
          </aside>

          <article className="min-w-0 max-w-[68ch]">
            <div className="prose-legal pg-legal">{body}</div>

            {(prev || next) && (
              <nav aria-label="Other documents" className="mt-16 grid gap-4 border-t border-line pt-10 sm:grid-cols-2">
                {prev ? (
                  <PagerCard href={prev.href} label={prev.label} group={prev.group} n={two(index)} dir="prev" />
                ) : (
                  <span className="hidden sm:block" />
                )}
                {next && <PagerCard href={next.href} label={next.label} group={next.group} n={two(index + 2)} dir="next" />}
              </nav>
            )}

            <div className="mt-10 border-t border-line pt-6">
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
