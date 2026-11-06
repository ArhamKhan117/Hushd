"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { IS_TESTNET, NETWORK } from "@/lib/hushd/config";
import { icons } from "./icons";
import { WalletMenu } from "./WalletMenu";

type NavItem = { href: string; label: string; icon: ReactNode; exact?: boolean; children?: { href: string; label: string }[] };

const nav: NavItem[] = [
  { href: "/app", label: "Desk", icon: icons.desk, exact: true },
  { href: "/app/deals", label: "Deals", icon: icons.deals },
  {
    href: "/app/balance",
    label: "Balance",
    icon: icons.balance,
    children: [
      { href: "/app/balance/add", label: "Add privately" },
      { href: "/app/balance/send", label: "Send privately" },
      { href: "/app/balance/receive", label: "Receive" },
      { href: "/app/balance/cash-out", label: "Cash out" },
    ],
  },
  { href: "/app/prove", label: "Prove", icon: icons.prove },
  { href: "/app/makers", label: "Makers", icon: icons.makers },
  { href: "/app/agents", label: "Agents", icon: icons.agents },
];
const tabs = nav.filter((n) => n.href !== "/app/agents");

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ item, active, onClick, sheet }: { item: { href: string; label: string; icon?: ReactNode }; active: boolean; onClick?: () => void; sheet?: boolean }) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] transition-colors ${
        active ? `${sheet ? "bg-panel" : "bg-surface"} font-medium text-foreground` : "text-mute hover:bg-surface/70 hover:text-foreground"
      }`}
    >
      {item.icon ?? <span aria-hidden className="w-[18px]" />}
      {item.label}
    </Link>
  );
}

function ProductNav({ pathname, sheet, onNavigate }: { pathname: string; sheet?: boolean; onNavigate?: () => void }) {
  return (
    <>
      {nav.map((item) => (
        <div key={item.href}>
          <NavLink item={item} active={isActive(pathname, item.href, item.exact) && !(item.children && item.children.some((c) => pathname.startsWith(c.href)))} onClick={onNavigate} sheet={sheet} />
          {item.children && isActive(pathname, item.href) && (
            <div className="ml-[30px] mt-0.5 flex flex-col gap-0.5 border-l border-line pl-2">
              {item.children.map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  onClick={onNavigate}
                  aria-current={pathname === c.href ? "page" : undefined}
                  className={`flex h-9 items-center rounded-lg px-3 text-[13.5px] transition-colors ${pathname === c.href ? "bg-surface font-medium text-foreground" : "text-mute hover:text-foreground"}`}
                >
                  {c.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function TabBar({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="App tabs" className="hd-tabbar fixed inset-x-0 bottom-0 z-30 border-t border-line bg-background/92 backdrop-blur-xl lg:hidden">
      <ul className="mx-auto flex max-w-[640px] items-stretch justify-around px-2">
        {tabs.map((item) => {
          const active = isActive(pathname, item.href, item.exact);
          return (
            <li key={item.href} className="min-w-0 flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-14 flex-col items-center justify-center gap-1 rounded-xl text-[11px] leading-none transition-colors ${active ? "font-medium text-foreground" : "text-mute hover:text-foreground"}`}
              >
                {item.icon}
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function NetworkBadge() {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line px-3 py-2 text-[13px]">
      <span className="flex items-center gap-2 text-soft">
        <span aria-hidden className="livedot h-1.5 w-1.5 rounded-full bg-accent" />
        NEAR {NETWORK.id}
      </span>
      <span className="text-faint">{IS_TESTNET ? "test tokens" : "real tokens"}</span>
    </div>
  );
}

/** The app frame: a floating sidebar on desktop, a slim top bar and a tab bar on phones. */
export function AppShell({ children, title, subtitle, actions }: { children: ReactNode; title: string; subtitle?: string; actions?: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="hushd-app relative flex min-h-svh flex-col bg-background">
      <aside className="hd-sidebar fixed bottom-3 left-3 top-3 z-40 w-[248px] flex-col rounded-[20px] border border-line bg-panel p-3 shadow-card" aria-label="App">
        <div className="flex items-center justify-between px-2 pb-5 pt-2">
          <Logo size={24} />
        </div>
        <NetworkBadge />
        <nav className="-mx-1 mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1 pb-3" aria-label="Product">
          <ProductNav pathname={pathname} />
        </nav>
        <div className="flex flex-col gap-0.5">
          <NavLink item={{ href: "/app/settings", label: "Settings", icon: icons.settings }} active={isActive(pathname, "/app/settings")} />
          <NavLink item={{ href: "/docs", label: "Docs", icon: icons.docs }} active={false} />
          <div className="mt-2 border-t border-line pt-3">
            <WalletMenu />
          </div>
        </div>
      </aside>

      <header className="hd-mobilebar sticky top-0 z-40 border-b border-line bg-background/90 backdrop-blur-xl">
        <div className="flex h-14 items-center justify-between gap-2 px-4">
          <Logo size={22} className="max-[359px]:[&>span]:hidden" />
          <div className="flex items-center gap-1.5">
            <WalletMenu compact />
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                {open ? <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : <path d="M4 8h16M4 16h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
              </svg>
            </button>
          </div>
        </div>
        {open && (
          <div className="h-[calc(100dvh-3.5rem)] overflow-y-auto border-t border-line bg-background px-4 pb-8 pt-4">
            <NetworkBadge />
            <nav className="mt-4 flex flex-col gap-0.5" aria-label="Product mobile">
              <ProductNav pathname={pathname} sheet onNavigate={() => setOpen(false)} />
              <NavLink item={{ href: "/app/settings", label: "Settings", icon: icons.settings }} active={isActive(pathname, "/app/settings")} onClick={() => setOpen(false)} sheet />
              <NavLink item={{ href: "/docs", label: "Docs", icon: icons.docs }} active={false} onClick={() => setOpen(false)} />
            </nav>
            <Link href="/" onClick={() => setOpen(false)} className="mt-5 block text-[14px] text-mute hover:text-foreground">
              Back to hushd.net
            </Link>
          </div>
        )}
      </header>

      <TabBar pathname={pathname} />

      <div className="hd-tabbar-space flex flex-1 flex-col lg:pl-[272px]">
        <main id="main" className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-16 pt-5 sm:px-8 sm:pt-7">
          <div className="hd-pagehead mb-6 gap-4 sm:mb-8">
            <div>
              <h1 className="t-display-m text-foreground">{title}</h1>
              {subtitle && <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-mute">{subtitle}</p>}
            </div>
            {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
          </div>
          <div className="rise rise-1">{children}</div>
        </main>
        <footer className="mx-auto w-full max-w-[1120px] px-4 pb-8 sm:px-8">
          <div className="flex flex-col gap-3 border-t border-line pt-5 text-[12.5px] text-mute sm:flex-row sm:items-center sm:justify-between">
            <p>Hushd on NEAR {NETWORK.id}. {IS_TESTNET ? "Test tokens only." : "Real tokens."} Not investment, legal or tax advice.</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Link href="/verify" className="hover:text-foreground">Verify a proof</Link>
              <Link href="/transparency" className="hover:text-foreground">Transparency</Link>
              <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
              <Link href="/terms" className="hover:text-foreground">Terms</Link>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
