"use client";

import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { PagerCard } from "@/components/pages/PagerCard";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import "@/styles/pages.css";
import "@/styles/docs.css";
import { ThemeSegmented } from "./ThemeToggle";
import { Footer } from "./Footer";
import { DocsCopyEnhancer } from "./DocsCopyEnhancer";
import {
  DocsNavList,
  FLAT_DOCS_NAV,
  currentDoc,
  findDocHeading,
  sectionNumber,
  slugify,
  type DocNavItem,
} from "./docs/DocsNav";
import { DOCS_HEADER_OFFSET, DocsTopBar } from "./docs/DocsTopBar";
import { CopyPageButton } from "./docs/CopyPageButton";
import { OnThisPage, TocMenu, type TocHeading } from "./docs/DocsToc";

export type { DocNavItem };

export type GlanceRow = { label: string; value: string };

const DEFAULT_QUICK_LINKS = [
  { href: "/app", label: "Open the desk" },
  { href: "/docs/quickstart", label: "Quickstart" },
  { href: "/verify", label: "Verify a proof" },
  { href: "/transparency", label: "Transparency" },
  { href: "/docs/privacy-model", label: "What stays private" },
  { href: "https://github.com/ArhamKhan117/Hushd", label: "GitHub" },
];

/** Section ids scroll to just under the sticky header (100px mobile, 112px desktop). */
const SPY_OFFSET = 150;

/**
 * Reads the h2s out of the rendered prose, gives any that lack one a stable id,
 * and tracks which section is in view. Navigation only: the content itself is
 * server-rendered and never waits on this.
 */
function useHeadings(rootRef: RefObject<HTMLDivElement | null>, pathname: string) {
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2"));
    const used = new Set<string>();
    const list: TocHeading[] = els.map((el, i) => {
      let id = el.id || slugify(el.textContent ?? "") || `section-${i + 1}`;
      while (used.has(id)) id = `${id}-${i + 1}`;
      used.add(id);
      if (!el.id) el.id = id;
      return { id, text: (el.textContent ?? "").trim() };
    });
    // h3s get an id too (for their anchor), but stay out of the rail
    root.querySelectorAll<HTMLHeadingElement>("h3").forEach((el, i) => {
      if (el.id) return;
      let id = slugify(el.textContent ?? "") || `part-${i + 1}`;
      while (used.has(id) || document.getElementById(id)) id = `${id}-${i + 1}`;
      used.add(id);
      el.id = id;
    });
    const anchors = addAnchors(root);

    // Honour a deep link that arrived before the ids existed, including search
    // links that point at a heading's text slug rather than its explicit id.
    // A malformed percent-encoded fragment (a truncated link) is used raw, since
    // decodeURIComponent would throw on it.
    const raw = window.location.hash.slice(1);
    let hash = raw;
    try {
      hash = decodeURIComponent(raw);
    } catch {
      /* not percent-encoded: look it up as written */
    }
    if (hash) findDocHeading(hash)?.scrollIntoView();

    let frame = 0;
    const update = () => {
      frame = 0;
      let current: string | null = list[0]?.id ?? null;
      for (const el of els) {
        if (el.getBoundingClientRect().top <= SPY_OFFSET) current = el.id;
        else break;
      }
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom && list.length) current = list[list.length - 1].id;
      setActiveId(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };

    // Defer the first read so state is set outside the effect body.
    const boot = window.requestAnimationFrame(() => {
      setHeadings(list);
      update();
    });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.cancelAnimationFrame(boot);
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      anchors.forEach((a) => a.remove());
    };
  }, [rootRef, pathname]);

  return { headings, activeId };
}

const ANCHOR_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

/**
 * A link to each heading, shown on hover or focus. Added after hydration as the
 * heading's last child, and removed again on navigation, so React's own nodes
 * are never touched.
 */
function addAnchors(root: HTMLElement) {
  const added: HTMLAnchorElement[] = [];
  root.querySelectorAll<HTMLHeadingElement>(":scope > h2[id], :scope > h3[id]").forEach((h) => {
    const a = document.createElement("a");
    a.className = "docs-anchor";
    a.href = `#${h.id}`;
    a.setAttribute("aria-label", `Link to this section: ${(h.textContent ?? "").trim()}`);
    a.innerHTML = ANCHOR_ICON;
    h.append(a);
    added.push(a);
  });
  return added;
}

/**
 * How far through the article the reader is, 0 to 1, as --docs-read on the
 * page root: the rail's track and the top bar's hairline both follow it. Set
 * straight on the element, so scrolling never re-renders React.
 */
function useReadingProgress(
  pageRef: RefObject<HTMLDivElement | null>,
  articleRef: RefObject<HTMLElement | null>,
  pathname: string
) {
  useEffect(() => {
    const page = pageRef.current;
    const article = articleRef.current;
    if (!page || !article) return;
    let frame = 0;
    let last = "";
    const update = () => {
      frame = 0;
      const r = article.getBoundingClientRect();
      const span = r.height - window.innerHeight + SPY_OFFSET;
      const p = span <= 0 ? 1 : Math.min(1, Math.max(0, (SPY_OFFSET - r.top) / span));
      const next = p.toFixed(4);
      if (next !== last) {
        last = next;
        page.style.setProperty("--docs-read", next);
      }
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [pageRef, articleRef, pathname]);
}

/**
 * Code blocks, tables and callouts below the fold rise into place once, the
 * first time they scroll into view. Prose itself never moves. Off under
 * reduced motion, and anything already on screen is simply there.
 */
function useProseRise(rootRef: RefObject<HTMLDivElement | null>, pathname: string) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = Array.from(root.querySelectorAll<HTMLElement>(":scope > :is(pre, table, aside)"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.docsRise = "in";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px" }
    );
    for (const el of els) {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.94) continue;
      el.dataset.docsRise = "armed";
      io.observe(el);
    }
    return () => {
      io.disconnect();
      els.forEach((el) => delete el.dataset.docsRise);
    };
  }, [rootRef, pathname]);
}

/**
 * Fits the sticky sidebar to the space under the header, so the Appearance row
 * at its foot stays on screen whatever sits above the header.
 */
function useRailHeight(railRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    let frame = 0;
    let last = "";
    const fit = () => {
      frame = 0;
      const header = document.querySelector<HTMLElement>("[data-docs-header]");
      const top = header ? Math.max(0, header.getBoundingClientRect().bottom) : 112;
      const next = `${Math.round(window.innerHeight - top)}px`;
      if (next !== last) {
        last = next;
        rail.style.height = next;
      }
    };
    const onChange = () => {
      if (!frame) frame = window.requestAnimationFrame(fit);
    };
    fit();
    window.addEventListener("scroll", onChange, { passive: true });
    window.addEventListener("resize", onChange);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onChange);
      window.removeEventListener("resize", onChange);
      rail.style.height = "";
    };
  }, [railRef]);
}

function QuickLink({ href, label }: { href: string; label: string }) {
  const cls = "docs-chip";
  if (href.startsWith("mailto:")) {
    return (
      <a href={href} className={cls}>
        {label}
      </a>
    );
  }
  if (href.startsWith("http")) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={cls}>
        {label}
        <ArrowUpRight className="text-faint" />
      </a>
    );
  }
  const To = href.startsWith("/app") ? AppLink : Link;
  return (
    <To href={href} className={cls}>
      {label}
    </To>
  );
}

export function DocsLayout({
  title,
  lede,
  children,
  glance,
  quickLinks,
}: {
  title: string;
  lede?: string;
  children: ReactNode;
  glance?: GlanceRow[];
  quickLinks?: { href: string; label: string }[];
}) {
  const pathname = usePathname();
  const pageRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const proseRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const { headings, activeId } = useHeadings(proseRef, pathname);
  useRailHeight(railRef);
  useReadingProgress(pageRef, articleRef, pathname);
  useProseRise(proseRef, pathname);

  const { index, item: here } = currentDoc(pathname);
  const prev = index > 0 ? FLAT_DOCS_NAV[index - 1] : undefined;
  const next = index >= 0 && index < FLAT_DOCS_NAV.length - 1 ? FLAT_DOCS_NAV[index + 1] : undefined;
  const links = quickLinks ?? DEFAULT_QUICK_LINKS;
  const rise = (d: number) => ({ "--d": d }) as CSSProperties;

  return (
    <div id="top" ref={pageRef} className="docs-page min-h-screen bg-background text-foreground">
      <DocsTopBar />

      <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-8">
        <div className="lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-x-10 xl:grid-cols-[248px_minmax(0,1fr)_216px] xl:gap-x-12">
          {/* Left: grouped nav, appearance at the foot */}
          <aside className="hidden lg:block">
            <div
              ref={railRef}
              className={`sticky ${DOCS_HEADER_OFFSET} -ml-3 flex h-[calc(100dvh-112px)] flex-col`}
            >
              <nav aria-label="Docs" className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 pr-2 pt-9">
                <DocsNavList pathname={pathname} />
              </nav>
              <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line py-4 pl-3">
                <span className="text-[12.5px] text-mute">Appearance</span>
                <ThemeSegmented />
              </div>
            </div>
          </aside>

          {/* Center: the reading column */}
          <main id="main" className="min-w-0 pb-6 pt-6 sm:pt-8 lg:pt-9">
            <article ref={articleRef} data-docs-article className="mx-auto w-full max-w-[760px]">
              {/* keyed to the page, so the title rises again on each one */}
              <header key={pathname} className="docs-head pg-band hd-crop">
                <div className="pg-band-light" aria-hidden />
                <div className="flex min-h-10 items-center justify-between gap-3 px-4 pt-4 sm:px-7 sm:pt-6">
                  <nav aria-label="Breadcrumb" className="pg-crumbs pg-rise">
                    <Link href="/docs" className="max-sm:hidden">
                      Docs
                    </Link>
                    <span data-sep aria-hidden className="max-sm:hidden">
                      /
                    </span>
                    <span className="hd-index" data-n={sectionNumber(here?.section ?? "")}>
                      <i />
                      {here?.section ?? "Docs"}
                    </span>
                    {here && (
                      <>
                        <span data-sep aria-hidden className="max-md:hidden">
                          /
                        </span>
                        <span aria-current="page" className="max-md:hidden">
                          {here.label}
                        </span>
                      </>
                    )}
                  </nav>
                  <div className="flex shrink-0 items-center gap-2">
                    {index >= 0 && (
                      <span className="pg-count mr-1 max-lg:hidden" aria-label={`Page ${index + 1} of ${FLAT_DOCS_NAV.length}`}>
                        <b>{String(index + 1).padStart(2, "0")}</b> / {String(FLAT_DOCS_NAV.length).padStart(2, "0")}
                      </span>
                    )}
                    <CopyPageButton title={title} lede={lede} />
                    <TocMenu headings={headings} activeId={activeId} />
                  </div>
                </div>

                <div className={`px-4 sm:px-7 ${glance && glance.length > 0 ? "pb-6 sm:pb-7" : "pb-7 sm:pb-9"}`}>
                  <h1
                    style={rise(1)}
                    className="pg-rise mt-7 text-balance text-[30px] font-medium leading-[1.12] tracking-[-0.022em] text-foreground sm:mt-9 md:text-[40px] md:leading-[1.08]"
                  >
                    {title}
                  </h1>
                  {lede && (
                    <p style={rise(2)} className="pg-rise mt-4 max-w-[60ch] text-pretty text-[16.5px] leading-[1.6] text-mute sm:text-[17px]">
                      {lede}
                    </p>
                  )}
                </div>

                {glance && glance.length > 0 && (
                  <dl style={rise(3)} data-n={glance.length} className="docs-glance pg-rise">
                    {glance.map((row) => (
                      <div key={row.label} className="docs-glance-cell">
                        <dt className="t-label">{row.label}</dt>
                        <dd className="tnum mt-1.5 break-words text-[14.5px] leading-snug text-foreground">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </header>

              {links.length > 0 && (
                <nav aria-label="Quick links" style={rise(4)} className="pg-rise mt-6 flex flex-wrap gap-2 sm:mt-7">
                  {links.map((l) => (
                    <QuickLink key={l.href} {...l} />
                  ))}
                </nav>
              )}

              <div ref={proseRef} className="docs-prose mt-12 space-y-5 text-[16px] leading-[26px] [&_td]:[overflow-wrap:break-word] [&_td_code]:[overflow-wrap:break-word]">
                {children}
              </div>
              <DocsCopyEnhancer />

              {(prev || next) && (
                <nav aria-label="Pagination" className="mt-16 grid gap-4 border-t border-line pt-10 sm:grid-cols-2">
                  {prev ? (
                    <PagerCard href={prev.href} label={prev.label} group={prev.section} n={sectionNumber(prev.section)} dir="prev" />
                  ) : (
                    <span className="hidden sm:block" />
                  )}
                  {next && <PagerCard href={next.href} label={next.label} group={next.section} n={sectionNumber(next.section)} dir="next" />}
                </nav>
              )}
            </article>
          </main>

          {/* Right: on this page */}
          <aside className="hidden xl:block">
            <div className={`sticky ${DOCS_HEADER_OFFSET} max-h-[calc(100dvh-112px)] overflow-y-auto pb-12 pt-10`}>
              <OnThisPage headings={headings} activeId={activeId} />
            </div>
          </aside>
        </div>
      </div>

      <Footer />
    </div>
  );
}
