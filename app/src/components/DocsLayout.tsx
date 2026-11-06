"use client";

import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { ArrowUpRight } from "@/components/ui/ArrowUpRight";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ThemeSegmented } from "./ThemeToggle";
import { Footer } from "./Footer";
import { DocsCopyEnhancer } from "./DocsCopyEnhancer";
import {
  DocsNavList,
  FLAT_DOCS_NAV,
  currentDoc,
  findDocHeading,
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
  { href: "https://github.com/ArhamKhan117/hushd", label: "GitHub" },
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

    // Honour a deep link that arrived before the ids existed, including search
    // links that point at a heading's text slug rather than its explicit id.
    // A fragment that is not valid percent-encoding (a link cut short, say
    // #%E0%A4) is read as it is: decoding it threw here, and the page broke.
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
    };
  }, [rootRef, pathname]);

  return { headings, activeId };
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
  const cls =
    "inline-flex h-10 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-soft transition-colors hover:border-line-strong hover:bg-surface/60 hover:text-foreground lg:h-8 lg:px-3";
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

function glanceCols(n: number) {
  if (n === 4) return "sm:grid-cols-4";
  if (n === 2) return "sm:grid-cols-2";
  return "sm:grid-cols-3";
}

function PagerLink({
  href,
  label,
  section,
  dir,
}: {
  href: string;
  label: string;
  section: string;
  dir: "prev" | "next";
}) {
  const next = dir === "next";
  return (
    <Link
      href={href}
      className={`group flex flex-col rounded-[18px] border border-line px-5 py-4 transition-colors hover:border-line-strong hover:bg-surface/50 ${
        next ? "items-end text-right" : ""
      }`}
    >
      <span className="text-[12.5px] text-mute">
        {!next && (
          <span aria-hidden className="mr-1.5 inline-block transition-transform group-hover:-translate-x-0.5">
            ←
          </span>
        )}
        {next ? "Next" : "Previous"}
        <span className="text-faint">{` · ${section}`}</span>
        {next && (
          <span aria-hidden className="ml-1.5 inline-block transition-transform group-hover:translate-x-0.5">
            →
          </span>
        )}
      </span>
      <span className="mt-1 text-[16px] font-medium tracking-[-0.01em] text-foreground">{label}</span>
    </Link>
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
  const proseRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const { headings, activeId } = useHeadings(proseRef, pathname);
  useRailHeight(railRef);

  const { index, item: here } = currentDoc(pathname);
  const prev = index > 0 ? FLAT_DOCS_NAV[index - 1] : undefined;
  const next = index >= 0 && index < FLAT_DOCS_NAV.length - 1 ? FLAT_DOCS_NAV[index + 1] : undefined;
  const links = quickLinks ?? DEFAULT_QUICK_LINKS;

  return (
    <div id="top" className="min-h-screen bg-background text-foreground">
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
          <main id="main" className="min-w-0 pb-6 pt-7 sm:pt-9 lg:pt-10">
            <article data-docs-article className="mx-auto w-full max-w-[760px]">
              <div className="flex min-h-8 items-center justify-between gap-3">
                <p className="truncate text-[13px] font-medium text-sealed">
                  {here?.section ?? "Docs"}
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  <CopyPageButton title={title} lede={lede} />
                  <TocMenu headings={headings} activeId={activeId} />
                </div>
              </div>

              <h1 className="mt-3 text-balance text-[30px] font-medium leading-[1.15] tracking-[-0.02em] text-foreground md:text-[36px] md:leading-[1.12]">
                {title}
              </h1>
              {lede && (
                <p className="mt-4 max-w-[64ch] text-pretty text-[17px] leading-[1.6] text-mute">{lede}</p>
              )}

              {glance && glance.length > 0 && (
                <dl
                  className={`hd-tile mt-8 grid grid-cols-2 gap-x-6 gap-y-5 p-5 sm:p-6 ${glanceCols(
                    glance.length
                  )}`}
                >
                  {glance.map((row) => (
                    <div key={row.label} className="min-w-0">
                      <dt className="t-label">{row.label}</dt>
                      <dd className="tnum mt-1.5 break-words text-[15px] leading-snug text-foreground">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}

              {links.length > 0 && (
                <nav
                  aria-label="Quick links"
                  className={`flex flex-wrap gap-2 ${glance && glance.length > 0 ? "mt-3" : "mt-7"}`}
                >
                  {links.map((l) => (
                    <QuickLink key={l.href} {...l} />
                  ))}
                </nav>
              )}

              <div ref={proseRef} className="docs-prose mt-10 space-y-5 text-[16px] leading-[26px] [&_td]:[overflow-wrap:break-word] [&_td_code]:[overflow-wrap:break-word]">
                {children}
              </div>
              <DocsCopyEnhancer />

              {(prev || next) && (
                <nav aria-label="Pagination" className="mt-16 grid gap-3 border-t border-line pt-10 sm:grid-cols-2">
                  {prev ? (
                    <PagerLink href={prev.href} label={prev.label} section={prev.section} dir="prev" />
                  ) : (
                    <span className="hidden sm:block" />
                  )}
                  {next && <PagerLink href={next.href} label={next.label} section={next.section} dir="next" />}
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
