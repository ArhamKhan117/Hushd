import Link from "next/link";
import { AppLink } from "./AppLink";
import { Mark } from "./Logo";
import { FooterWordmark } from "./FooterWordmark";
import { ThemeSegmented } from "./ThemeToggle";
import { ArrowUpRight } from "./ui/ArrowUpRight";

const GITHUB = "https://github.com/ArhamKhan117/Hushd";

type FooterLink = { href: string; label: string };

const groups: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/app", label: "Desk" },
      { href: "/agents", label: "Agents" },
      { href: "/verify", label: "Verify a proof" },
      { href: "/transparency", label: "Transparency" },
    ],
  },
  {
    title: "Build",
    links: [
      { href: "/docs", label: "Docs" },
      { href: "/sdk", label: "Developers" },
      { href: "/docs/makers", label: "Run a maker" },
      { href: GITHUB, label: "GitHub" },
    ],
  },
  {
    title: "Trust",
    links: [
      { href: "/security", label: "Security" },
      { href: "/docs/privacy-model", label: "Privacy model" },
      { href: "/docs/contracts", label: "Contracts" },
    ],
  },
];

const legal: FooterLink[] = [
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
  { href: "/cookies", label: "Cookies" },
];

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.93.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  );
}

const linkClass = "hd-tap inline-flex items-center gap-1.5 text-[14.5px] text-soft transition-colors hover:text-foreground";

function FooterLinkItem({ l }: { l: FooterLink }) {
  if (l.href.startsWith("http")) {
    return (
      <a href={l.href} target="_blank" rel="noreferrer" className={linkClass}>
        {l.label} <ArrowUpRight className="text-faint" />
      </a>
    );
  }
  if (l.href.startsWith("/app")) {
    return (
      <AppLink href={l.href} className={linkClass}>
        {l.label}
      </AppLink>
    );
  }
  return (
    <Link href={l.href} className={linkClass}>
      {l.label}
    </Link>
  );
}

/**
 * Footer for the public pages: an ink panel in either theme with the links, then the
 * name across the foot of the page, cut by its edge.
 */
export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto w-full max-w-[1400px] px-4 pt-24 sm:px-7 sm:pt-32">
      <div className="theme-dark hd-panel rounded-[28px] border border-transparent bg-background text-foreground dark:border-line dark:bg-panel">
        <div className="relative z-10 mx-auto max-w-[1240px] px-6 pb-8 pt-12 sm:px-12 sm:pb-10 sm:pt-16">
          <div className="grid gap-12 lg:grid-cols-[1.25fr_2fr]">
            <div>
              <div className="flex items-center gap-2.5">
                <Mark size={26} />
                <span className="text-[19px] font-medium tracking-[-0.015em]">Hushd</span>
              </div>
              <p className="mt-6 max-w-[17ch] text-[26px] font-light leading-[1.15] tracking-[-0.02em] text-soft">
                Private OTC, run by agents.
              </p>
              <div className="-ml-3 mt-8 flex items-center gap-1">
                <a
                  href={GITHUB}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Hushd on GitHub"
                  className="grid h-10 w-10 place-items-center rounded-full text-soft transition-colors hover:bg-surface-2 hover:text-foreground"
                >
                  <GitHubIcon />
                </a>
                <AppLink href="/app" className="btn btn-ink btn-sm ml-2">
                  Open the desk
                </AppLink>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-8 gap-y-10 sm:grid-cols-3">
              {groups.map((g) => (
                <div key={g.title}>
                  <p className="text-[11.5px] font-medium uppercase tracking-[0.14em] text-foreground">{g.title}</p>
                  <ul className="mt-5 space-y-3">
                    {g.links.map((l) => (
                      <li key={l.href}>
                        <FooterLinkItem l={l} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-14 flex flex-col gap-5 border-t border-line pt-6 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-[12.5px] leading-relaxed text-mute">© {year} Arham Khan</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <ThemeSegmented />
              <nav aria-label="Legal" className="flex flex-wrap items-center text-[12.5px] text-mute">
                {legal.map((l, i) => (
                  <span key={l.href} className="flex items-center">
                    {i > 0 && <span aria-hidden className="mx-3 h-3 w-px bg-line-strong" />}
                    <Link href={l.href} className="hd-tap transition-colors hover:text-foreground">
                      {l.label}
                    </Link>
                  </span>
                ))}
              </nav>
            </div>
          </div>
        </div>
      </div>
      <FooterWordmark />
    </footer>
  );
}
