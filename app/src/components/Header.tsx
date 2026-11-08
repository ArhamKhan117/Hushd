"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AppLink } from "./AppLink";
import { Logo } from "./Logo";
import { ArrowUpRight } from "./ui/ArrowUpRight";
import { ThemeSegmented, ThemeToggle } from "./ThemeToggle";

export const MARKETING_LINKS = [
  { href: "/agents", label: "Agents" },
  { href: "/sdk", label: "Developers" },
  { href: "/docs", label: "Docs" },
];

/** Marketing nav, shared by the landing, docs, legal and SDK pages. */
function isCurrent(pathname: string, href: string) {
  if (href.startsWith("/#")) return false;
  if (href === "/docs") {
    return pathname === "/docs" || pathname.startsWith("/docs/");
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Header() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header
      className={`sticky top-0 z-50 px-2 transition-[background-color,box-shadow] duration-200 sm:px-3 ${
        open ? "bg-background shadow-[0_1px_0_var(--line)]" : "bg-transparent"
      }`}
    >
      {/* docks into a floating framed bar once the page scrolls */}
      <div
        data-docked={scrolled && !open}
        className="hd-dockbar mx-auto flex h-16 max-w-[1400px] items-center justify-between gap-4 px-2 sm:px-4 data-[docked=true]:h-14"
      >
        <Logo />
        <nav className="hidden items-center gap-8 lg:flex" aria-label="Primary">
          {MARKETING_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={isCurrent(pathname, l.href) ? "page" : undefined}
              className={`hd-navlink text-[14px] transition-colors hover:text-foreground ${
                isCurrent(pathname, l.href) ? "text-foreground" : "text-soft"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle className="hidden sm:grid" />
          {/* One action. Docs is already in the nav, and the accent is kept
              for what is private, so the button is plain ink. */}
          <AppLink href="/app" className="btn btn-ink btn-sm">
            Open app <ArrowUpRight />
          </AppLink>
          <button
            type="button"
            className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface lg:hidden"
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      {open && (
        <div
          id="mobile-nav"
          className="h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line bg-background lg:hidden"
        >
          <nav className="flex flex-col px-4 py-4" aria-label="Mobile">
            {MARKETING_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="flex min-h-14 items-center border-b border-line text-[22px] font-light tracking-[-0.015em] text-foreground"
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <div className="mt-6 flex items-center justify-between">
              <span className="text-[14px] text-mute">Appearance</span>
              <ThemeSegmented />
            </div>
            <div className="mt-6">
              <AppLink
                href="/app"
                className="btn btn-ink btn-lg btn-block"
                onClick={() => setOpen(false)}
              >
                Open app
              </AppLink>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8h16M4 16h16"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
