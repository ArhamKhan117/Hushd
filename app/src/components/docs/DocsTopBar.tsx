"use client";

import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { ThemeSegmented, ThemeToggle } from "@/components/ThemeToggle";
import { DOCS_TABS, DocsNavList, activeTab } from "./DocsNav";
import { SearchField, SearchIconButton, SearchPalette, useSearchShortcut } from "./DocsSearch";
import { CloseIcon, GitHubIcon, MenuIcon } from "./docsUi";

const GITHUB_URL = "https://github.com/ArhamKhan117/hushd";

/** Desktop and mobile header heights, so sticky rails can sit right under it. */
export const DOCS_HEADER_OFFSET = "top-[100px] lg:top-[112px]";

function Brand({ size = 26 }: { size?: number }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Logo size={size} />
      <Link
        href="/docs"
        className="hd-tap rounded-md text-[19px] leading-none tracking-[-0.015em] text-mute transition-colors hover:text-foreground"
      >
        Docs
      </Link>
    </span>
  );
}

function Tabs({ pathname }: { pathname: string }) {
  const current = activeTab(pathname);
  const rowRef = useRef<HTMLDivElement>(null);

  // Keep the active tab in view on narrow screens, where the row scrolls.
  useEffect(() => {
    const row = rowRef.current;
    const el = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !el) return;
    const left = el.offsetLeft - 16;
    const right = el.offsetLeft + el.offsetWidth + 16;
    if (left < row.scrollLeft || right > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: Math.max(0, left), behavior: "auto" });
    }
  }, [pathname]);

  return (
    <div
      ref={rowRef}
      className="-mb-px overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <nav aria-label="Docs sections" className="flex h-11 w-max items-stretch gap-6 px-4 sm:px-6 lg:h-12 lg:gap-8 lg:px-8">
        {DOCS_TABS.map((t) => {
          const on = current?.href === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={on ? "page" : undefined}
              className={`relative flex items-center whitespace-nowrap text-[14px] transition-colors ${
                on ? "font-medium text-foreground" : "text-mute hover:text-foreground"
              }`}
            >
              {t.label}
              <span
                aria-hidden
                className={`absolute inset-x-0 bottom-0 h-[2px] rounded-full transition-colors ${
                  on ? "bg-foreground" : "bg-transparent"
                }`}
              />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function MobileSheet({
  open,
  pathname,
  onClose,
  onSearch,
}: {
  open: boolean;
  pathname: string;
  onClose: () => void;
  onSearch: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, [open, onClose]);

  return (
    <div className={`fixed inset-0 z-[70] lg:hidden ${open ? "" : "pointer-events-none"}`} inert={!open}>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close menu"
        onClick={onClose}
        className={`absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Docs menu"
        className={`absolute inset-y-0 left-0 flex w-[min(340px,88vw)] flex-col bg-background shadow-pop transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line pl-4 pr-2">
          <Brand size={24} />
          <button
            type="button"
            data-autofocus
            onClick={onClose}
            aria-label="Close menu"
            className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="px-3 pt-4">
          <SearchField
            hint={false}
            onOpen={() => {
              onClose();
              onSearch();
            }}
          />
        </div>
        <nav aria-label="Docs" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-6 pt-6">
          <DocsNavList pathname={pathname} onNavigate={onClose} dense />
        </nav>
        <div className="shrink-0 space-y-3 border-t border-line px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-mute">Appearance</span>
            <ThemeSegmented />
          </div>
          <div className="flex gap-2">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="btn btn-ghost flex-1"
            >
              <GitHubIcon />
              GitHub
            </a>
            <AppLink href="/app" onClick={onClose} className="btn btn-ink flex-1">
              Open app
            </AppLink>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Docs chrome: brand, search and actions on top, section tabs below, both
 * sticky. Below lg a menu button opens the sidebar as a sheet.
 */
export function DocsTopBar() {
  const pathname = usePathname();
  const [searchOpen, setSearchOpen] = useState(false);
  // Keyed to the path so the sheet closes itself after a navigation.
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const sheetOpen = sheetFor === pathname;

  const openSearch = useCallback(() => setSearchOpen(true), []);
  const closeSearch = useCallback(() => setSearchOpen(false), []);
  const toggleSearch = useCallback(() => setSearchOpen((v) => !v), []);
  const closeSheet = useCallback(() => setSheetFor(null), []);
  useSearchShortcut(toggleSearch, openSearch);

  return (
    <>
      <header data-docs-header className="sticky top-0 z-40 border-b border-line bg-background/90 backdrop-blur-xl supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto max-w-[1440px]">
          <div className="flex h-14 items-center gap-2 px-2 sm:px-4 lg:grid lg:h-16 lg:grid-cols-[1fr_minmax(0,440px)_1fr] lg:gap-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setSheetFor(pathname)}
                aria-label="Open docs menu"
                aria-expanded={sheetOpen}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-foreground transition-colors hover:bg-surface lg:hidden"
              >
                <MenuIcon />
              </button>
              <span className="pl-1 lg:pl-0">
                <Brand size={24} />
              </span>
            </div>

            <div className="hidden lg:block">
              <SearchField onOpen={openSearch} />
            </div>

            <div className="ml-auto flex items-center justify-end gap-1 lg:ml-0 lg:gap-2">
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="hidden h-9 items-center gap-2 rounded-full px-3 text-[14px] text-soft transition-colors hover:bg-surface hover:text-foreground md:inline-flex"
              >
                <GitHubIcon />
                GitHub
              </a>
              <SearchIconButton onOpen={openSearch} className="lg:hidden" />
              <span className="hidden sm:block">
                <ThemeToggle />
              </span>
              <AppLink href="/app" className="btn btn-ink btn-sm ml-1 hidden sm:inline-flex">
                Open app
              </AppLink>
            </div>
          </div>
          <Tabs pathname={pathname} />
        </div>
      </header>

      <MobileSheet open={sheetOpen} pathname={pathname} onClose={closeSheet} onSearch={openSearch} />
      {searchOpen && <SearchPalette onClose={closeSearch} />}
    </>
  );
}
