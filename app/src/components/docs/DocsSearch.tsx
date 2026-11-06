"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { FLAT_DOCS_NAV, DOCS_NAV, findDocHeading, slugify } from "./DocsNav";
import { CloseIcon, HashIcon, Kbd, PageIcon, SearchIcon, useIsMac } from "./docsUi";

/* ------------------------------------------------------------------ */
/* Static index: the nav list plus a hand-written description, a few   */
/* keywords people actually type, and each page's h2 headings.         */
/* ------------------------------------------------------------------ */

type PageMeta = { description: string; keywords: string[]; headings: string[] };

export const PAGE_META: Record<string, PageMeta> = {
  "/docs": {
    description: "What Hushd is, what works today on testnet, and where to start.",
    keywords: ["intro", "what is hushd", "otc", "desk", "overview", "testnet"],
    headings: ["What Hushd is", "What works today", "What it is not", "Where to start"],
  },
  "/docs/quickstart": {
    description: "Sign in, get test tokens, add them privately and ask the desk, in a few minutes.",
    keywords: ["start", "faucet", "test tokens", "passkey", "wallet", "sign in", "first deal", "add privately", "shield"],
    headings: ["What you need", "1. Sign in", "2. Get test tokens", "3. Add privately", "4. Ask the desk", "5. Read the receipt", "6. Prove it to one reader", "If something goes wrong", "Next"],
  },
  "/docs/desk": {
    description: "A deal end to end: the sealed request, the enclave match, settlement and the receipt.",
    keywords: ["rfq", "request", "quote", "matcher", "enclave", "tee", "outlayer", "open_rfq", "intake", "near ai"],
    headings: ["The parts", "1. The request", "2. What makers see", "3. Quotes and the match", "4. Settlement", "5. The receipt", "Plain-language intake", "Who can do what"],
  },
  "/docs/packages": {
    description: "Spot, spot + hedge and cash and carry, the settlement classes, bonds and receipts.",
    keywords: ["spot", "hedge", "carry", "hyperliquid", "bond", "slash", "chain signatures", "receipt", "settle_swap", "atomic"],
    headings: ["The three packages", "Spot", "Spot and hedge", "Cash and carry", "Bonds and slashing", "Closing the hedge", "Receipts"],
  },
  "/docs/proofs": {
    description: "Prove one fact about a payment, a balance or desk volume to one named NEAR account, with an expiry.",
    keywords: ["prove", "proof", "reader", "auditor", "expiry", "verify", "verify_disclosure", "funds", "volume", "receipt"],
    headings: ["What a proof is", "The four kinds", "One named reader", "Expiry", "Checking a proof", "What a proof does not show", "Making one"],
  },
  "/docs/agents": {
    description: "The Hushd MCP server: local with the agent's own seed and spending limits, or hosted and read-only.",
    keywords: ["mcp", "claude", "agent", "limits", "HUSHD_LIMIT_PER_PAYMENT", "HUSHD_LIMIT_PER_DAY", "tools", "hosted", "seed"],
    headings: ["Two ways to connect", "Run it locally", "The hosted, read-only server", "Tools", "Spending limits", "Environment", "What stays on the agent's machine", "For coding agents"],
  },
  "/docs/x402": {
    description: "Pay for an HTTP resource from a private balance, and check such a payment on your server.",
    keywords: ["x402", "402", "payment required", "X-PAYMENT", "scheme hushd", "paywall", "api payments"],
    headings: ["How it works", "The 402 answer", "Paying", "Checking a payment", "Replays", "What the chain shows", "A live example: maker quotes"],
  },
  "/docs/makers": {
    description: "What a maker is, how the reference makers price and quote, and how to run your own.",
    keywords: ["maker", "market maker", "quote key", "bond", "spread", "pricing", "register_maker", "liquidity"],
    headings: ["What a maker is", "The reference makers", "Pricing", "Quoting", "Settling the leg", "Bonds", "Run one", "Selling quotes over x402"],
  },
  "/docs/sdk": {
    description: "@hushd/sdk: identities, the private wallet, the desk, proofs, intake and x402 in TypeScript.",
    keywords: ["sdk", "typescript", "package", "api", "exports", "PrivateWallet", "poolView", "deskView", "import"],
    headings: ["Install", "A trade, end to end", "A private payment", "Exports", "Guardrails"],
  },
  "/docs/privacy-model": {
    description: "Exactly what is public, what is private, what can leak, and who you trust.",
    keywords: ["privacy", "public", "private", "leak", "timing", "anonymity set", "relayer", "matcher", "what is hidden"],
    headings: ["Who sees what", "What is public, and why", "What is private", "What can leak", "Who you trust, and with what", "On your device"],
  },
  "/docs/threat-model": {
    description: "What each part can and cannot do to you, the dev proving keys, and how to report a problem.",
    keywords: ["security", "threat", "attack", "trusted setup", "keys", "audit", "bug", "report", "relayer", "tee"],
    headings: ["What Hushd protects", "Your keys and notes", "The relayer", "The matcher enclave", "The intake model", "Makers", "The contracts", "Proving keys", "Not audited", "Not covered", "Reporting a problem"],
  },
  "/docs/contracts": {
    description: "The testnet accounts, what each contract does, its events, and how to check them on NearBlocks.",
    keywords: ["contracts", "addresses", "accounts", "pool.hushd.testnet", "desk.hushd.testnet", "board", "nearblocks", "events", "nep-297"],
    headings: ["Accounts", "Pool", "Desk", "Board", "Test tokens", "Events", "Check them yourself"],
  },
};


type Entry = {
  key: string;
  kind: "page" | "heading";
  href: string;
  title: string;
  context: string;
  /** normalised fields, highest weight first */
  fields: { text: string; weight: number }[];
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”"’'?]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const PAGE_ENTRIES: Entry[] = FLAT_DOCS_NAV.map((item) => {
  const meta = PAGE_META[item.href];
  return {
    key: item.href,
    kind: "page",
    href: item.href,
    title: item.label,
    context: meta?.description ?? item.section,
    fields: [
      { text: norm(item.label), weight: 10 },
      { text: norm((meta?.keywords ?? []).join(" | ")), weight: 6 },
      { text: norm(item.section), weight: 3 },
      { text: norm(meta?.description ?? ""), weight: 2 },
    ],
  };
});

const HEADING_ENTRIES: Entry[] = FLAT_DOCS_NAV.flatMap((item) =>
  (PAGE_META[item.href]?.headings ?? []).map((h) => ({
    key: `${item.href}#${slugify(h)}`,
    kind: "heading" as const,
    href: `${item.href}#${slugify(h)}`,
    title: h,
    context: item.label,
    fields: [
      { text: norm(h), weight: 8 },
      { text: norm(item.label), weight: 2 },
    ],
  }))
);

type Group = { label: string; items: Entry[] };

function search(query: string): Group[] {
  const q = norm(query);
  if (!q) {
    return DOCS_NAV.map((g) => ({
      label: g.section,
      items: g.items.map((i) => PAGE_ENTRIES.find((e) => e.href === i.href)!),
    }));
  }
  const terms = q.split(" ").filter(Boolean);
  const score = (e: Entry) => {
    let total = 0;
    let ownHit = false;
    for (const t of terms) {
      let best = 0;
      for (const f of e.fields) {
        if (f.weight > best && f.text.includes(t)) best = f.weight;
      }
      if (!best) return 0;
      if (e.fields[0].text.includes(t)) ownHit = true;
      total += best;
    }
    // A section must match on its own words, not only on its page's title.
    if (e.kind === "heading" && !ownHit) return 0;
    const title = e.fields[0].text;
    if (title === q) total += 20;
    else if (title.startsWith(q)) total += 10;
    else if (title.split(" ").some((w) => w.startsWith(terms[0]))) total += 3;
    return total;
  };
  const rank = (list: Entry[], limit: number) =>
    list
      .map((e) => ({ e, s: score(e) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit);

  const pages = rank(PAGE_ENTRIES, 8);
  const headings = rank(HEADING_ENTRIES, 12);
  const groups: (Group & { best: number })[] = [];
  if (pages.length) groups.push({ label: "Pages", items: pages.map((x) => x.e), best: pages[0].s + 1 });
  if (headings.length) groups.push({ label: "Sections", items: headings.map((x) => x.e), best: headings[0].s });
  // Whichever group holds the strongest match leads, so Enter opens it.
  return groups.sort((a, b) => b.best - a.best);
}

/** Bolds the parts of `text` that match a query term. */
function Marked({ text, query }: { text: string; query: string }) {
  const terms = norm(query)
    .split(" ")
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-medium text-foreground">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Triggers                                                            */
/* ------------------------------------------------------------------ */

export function SearchField({
  onOpen,
  hint = true,
  className = "",
}: {
  onOpen: () => void;
  /** Show the ⌘K / Ctrl K chip (off in the touch sheet). */
  hint?: boolean;
  className?: string;
}) {
  const mac = useIsMac();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search the docs"
      aria-haspopup="dialog"
      className={`group flex h-10 w-full items-center gap-2.5 rounded-xl border border-transparent bg-surface pl-3.5 pr-2 text-left text-[14px] text-faint transition-colors hover:border-line-strong hover:bg-panel ${className}`}
    >
      <SearchIcon className="shrink-0 text-mute" />
      <span className="min-w-0 flex-1 truncate">Search the docs</span>
      {hint && <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>}
    </button>
  );
}

export function SearchIconButton({ onOpen, className = "" }: { onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search the docs"
      aria-haspopup="dialog"
      className={`grid h-10 w-10 place-items-center rounded-full text-foreground transition-colors hover:bg-surface ${className}`}
    >
      <SearchIcon size={18} />
    </button>
  );
}

/** ⌘K / Ctrl K toggles, "/" opens (when not typing somewhere). */
export function useSearchShortcut(toggle: () => void, open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle, open]);
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

export function SearchPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const mac = useIsMac();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;

  const groups = useMemo(() => search(query), [query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = flat[Math.min(active, flat.length - 1)];

  // Focus the field on open; hand focus back to the trigger on close.
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      if (back && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  const go = (entry: Entry) => {
    const [path, hash] = entry.href.split("#");
    onClose();
    if (path === pathname) {
      if (hash) {
        findDocHeading(hash)?.scrollIntoView({ block: "start" });
        window.history.replaceState(null, "", `#${hash}`);
      } else {
        window.scrollTo({ top: 0 });
      }
      return;
    }
    router.push(entry.href);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const n = flat.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (n) setActive((i) => (Math.min(i, n - 1) + 1) % n);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (n) setActive((i) => (Math.min(i, n - 1) - 1 + n) % n);
    } else if (e.key === "Home" && e.ctrlKey) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      e.preventDefault();
      setActive(Math.max(0, n - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current) go(current);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // Keep focus in the field; the list is driven by the arrows.
      e.preventDefault();
      if (n) setActive((i) => (Math.min(i, n - 1) + (e.shiftKey ? -1 + n : 1)) % n);
    }
  };

  const onItemClick = (e: ReactMouseEvent, entry: Entry) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    go(entry);
  };

  let flatIndex = -1;

  return (
    <div className="fixed inset-0 z-[80]" onKeyDown={onKeyDown}>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm transition-opacity duration-150 starting:opacity-0"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search the docs"
        className="relative mx-auto mt-3 flex max-h-[calc(100dvh-24px)] w-[calc(100%-24px)] max-w-[640px] flex-col overflow-hidden rounded-[20px] border border-line bg-panel shadow-pop transition-[opacity,transform] duration-150 ease-out starting:opacity-0 motion-safe:starting:translate-y-1 sm:mt-[12vh] sm:max-h-[min(560px,76vh)] sm:w-[calc(100%-32px)] sm:rounded-[24px]"
      >
        <div className="flex h-14 shrink-0 items-center gap-3 border-b border-line pl-4 pr-2.5 sm:h-[60px] sm:pl-5">
          <SearchIcon size={18} className="shrink-0 text-mute" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={flat.length > 0}
            aria-controls={listId}
            aria-activedescendant={current ? `${uid}-${current.key}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search pages and sections"
            // The field is the dialog's focus home; the global focus ring would box it in.
            style={{ outline: "none" }}
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-foreground placeholder:text-faint"
          />
          <button
            type="button"
            onClick={onClose}
            className="hidden h-8 items-center rounded-lg px-1.5 text-mute transition-colors hover:bg-surface sm:inline-flex"
            aria-label="Close search"
          >
            <Kbd>Esc</Kbd>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-full text-mute transition-colors hover:bg-surface hover:text-foreground sm:hidden"
            aria-label="Close search"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {flat.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-[15px] text-foreground">No results for “{query.trim()}”</p>
              <p className="mt-1.5 text-[13.5px] text-mute">
                Try a page name, a feature like hedge, or a term like faucet.
              </p>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label} role="group" aria-label={group.label} className="mb-1 last:mb-0">
                <p className="t-label px-3 pb-1.5 pt-3">{group.label}</p>
                {group.items.map((entry) => {
                  flatIndex += 1;
                  const i = flatIndex;
                  const on = current?.key === entry.key;
                  return (
                    <ResultRow
                      key={entry.key}
                      id={`${uid}-${entry.key}`}
                      entry={entry}
                      query={query}
                      active={on}
                      onHover={() => setActive(i)}
                      onClick={(e) => onItemClick(e, entry)}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="hidden shrink-0 items-center gap-5 border-t border-line px-5 py-2.5 text-[12px] text-mute sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            to move
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            to open
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5">
            <Kbd>{mac ? "⌘K" : "Ctrl K"}</Kbd>
            anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

function ResultRow({
  id,
  entry,
  query,
  active,
  onHover,
  onClick,
}: {
  id: string;
  entry: Entry;
  query: string;
  active: boolean;
  onHover: () => void;
  onClick: (e: ReactMouseEvent) => void;
}): ReactNode {
  const Icon = entry.kind === "page" ? PageIcon : HashIcon;
  return (
    <Link
      id={id}
      href={entry.href}
      role="option"
      aria-selected={active}
      data-active={active}
      tabIndex={-1}
      onMouseMove={active ? undefined : onHover}
      onClick={onClick}
      className={`flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 transition-colors ${
        active ? "bg-surface" : ""
      }`}
    >
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line ${
          active ? "bg-panel text-foreground" : "text-mute"
        }`}
      >
        <Icon />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14.5px] leading-snug text-foreground">
          <Marked text={entry.title} query={query} />
        </span>
        <span className="mt-0.5 block truncate text-[12.5px] leading-snug text-mute">
          {entry.kind === "heading" ? `In ${entry.context}` : entry.context}
        </span>
      </span>
      <span
        aria-hidden
        className={`hidden shrink-0 transition-opacity sm:block ${active ? "opacity-100" : "opacity-0"}`}
      >
        <Kbd>Enter</Kbd>
      </span>
    </Link>
  );
}
