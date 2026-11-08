"use client";

import Link from "next/link";

/**
 * The docs map: sidebar groups, top tabs, and the helpers that decide what is
 * "here". Shared by the layout, the top bar, the mobile sheet and search.
 */

export type DocNavItem = {
  href: string;
  label: string;
};

export type DocNavGroup = { section: string; items: DocNavItem[] };

export const DOCS_NAV: DocNavGroup[] = [
  {
    section: "Start here",
    items: [
      { href: "/docs", label: "Overview" },
      { href: "/docs/quickstart", label: "Quickstart" },
    ],
  },
  {
    section: "The desk",
    items: [
      { href: "/docs/desk", label: "How the desk works" },
      { href: "/docs/packages", label: "Packages and settlement" },
      { href: "/docs/proofs", label: "Proofs" },
    ],
  },
  {
    section: "Agents and builders",
    items: [
      { href: "/docs/agents", label: "Agents and MCP" },
      { href: "/docs/x402", label: "Private x402" },
      { href: "/docs/makers", label: "Makers" },
      { href: "/docs/sdk", label: "SDK" },
    ],
  },
  {
    section: "Trust",
    items: [
      { href: "/docs/privacy-model", label: "Privacy model" },
      { href: "/docs/threat-model", label: "Security and threat model" },
      { href: "/docs/contracts", label: "Contracts" },
    ],
  },
];

export type FlatDocNavItem = DocNavItem & { section: string };

export const FLAT_DOCS_NAV: FlatDocNavItem[] = DOCS_NAV.flatMap((g) => g.items.map((i) => ({ ...i, section: g.section })));

const ALL_HREFS = FLAT_DOCS_NAV.map((i) => i.href);

/** Section tabs under the top bar. `match` lists the pages each tab owns. */
export type DocsTab = { label: string; href: string; match: string[] };

export const DOCS_TABS: DocsTab[] = [
  { label: "Overview", href: "/docs", match: ["/docs", "/docs/quickstart"] },
  { label: "The desk", href: "/docs/desk", match: ["/docs/desk", "/docs/packages", "/docs/proofs"] },
  { label: "Agents", href: "/docs/agents", match: ["/docs/agents", "/docs/x402", "/docs/makers"] },
  { label: "SDK", href: "/docs/sdk", match: ["/docs/sdk"] },
  { label: "Trust", href: "/docs/privacy-model", match: ["/docs/privacy-model", "/docs/threat-model", "/docs/contracts"] },
];

export function isDocActive(pathname: string, href: string) {
  if (pathname === href) return true;
  if (!pathname.startsWith(`${href}/`)) return false;
  // Prefix match only counts if no more-specific nav item also matches, so a
  // parent (/docs) does not light up on a child route (/docs/sdk).
  return !ALL_HREFS.some((h) => h !== href && h.startsWith(`${href}/`) && (pathname === h || pathname.startsWith(`${h}/`)));
}

export function currentDoc(pathname: string) {
  const index = FLAT_DOCS_NAV.findIndex((i) => isDocActive(pathname, i.href));
  return { index, item: index >= 0 ? FLAT_DOCS_NAV[index] : undefined };
}

export function activeTab(pathname: string): DocsTab | undefined {
  const href = currentDoc(pathname).item?.href ?? pathname;
  return DOCS_TABS.find((t) => t.match.includes(href));
}

export function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 64);
}

/** Finds a prose heading by id, or by the slug of its text (search deep links). */
export function findDocHeading(hash: string): HTMLElement | null {
  if (!hash) return null;
  const byId = document.getElementById(hash);
  if (byId) return byId;
  const all = document.querySelectorAll<HTMLElement>(".docs-prose h2, .docs-prose h3");
  for (const el of all) {
    if (slugify(el.textContent ?? "") === hash) return el;
  }
  return null;
}

/** "01", "02"…: a section's place in the docs, shared by the sidebar and the breadcrumb. */
export function sectionNumber(section: string) {
  const i = DOCS_NAV.findIndex((g) => g.section === section);
  return i < 0 ? "" : String(i + 1).padStart(2, "0");
}

/**
 * The grouped page list. Each group sits on a hairline track; the page you are
 * on is marked by a steel rule on that track, not a filled pill.
 */
export function DocsNavList({ pathname, onNavigate, dense = false }: { pathname: string; onNavigate?: () => void; dense?: boolean }) {
  return (
    <>
      {DOCS_NAV.map((group, gi) => (
        <div key={group.section} className="docs-nav-group">
          <p className="docs-nav-label">
            <span className="hd-index" data-n={String(gi + 1).padStart(2, "0")}>
              <i />
              {group.section}
            </span>
          </p>
          <ul className="docs-nav-list">
            {group.items.map((item) => {
              const active = isDocActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    data-dense={dense || undefined}
                    className="docs-nav-link"
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}
