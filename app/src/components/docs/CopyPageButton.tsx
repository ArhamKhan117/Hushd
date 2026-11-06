"use client";

import { usePathname } from "next/navigation";
import { useCallback, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  LinkIcon,
  MarkdownIcon,
  PageIcon,
  useDismiss,
} from "./docsUi";

/* ------------------------------------------------------------------ */
/* Reading the page                                                    */
/* ------------------------------------------------------------------ */

/** The prose root for the current page. */
function proseRoot() {
  return document.querySelector<HTMLElement>("[data-docs-article] .docs-prose");
}

function pageUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

/**
 * Plain text as the reader sees it (innerText keeps line breaks). Code blocks
 * swap back to their original source and the injected chrome (language label,
 * copy button) drops out while we read, all inside one synchronous frame.
 */
function pageText(title: string, lede?: string) {
  const root = proseRoot();
  let body = "";
  if (root) {
    root.classList.add("is-copying");
    body = root.innerText;
    root.classList.remove("is-copying");
  }
  return [title, lede, body.trim(), `Source: ${pageUrl()}`]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Code-block labels (set by DocsCopyEnhancer) to Markdown fence languages. */
const FENCE_LANG: Record<string, string> = {
  TypeScript: "ts",
  JavaScript: "js",
  JSON: "json",
  Terminal: "bash",
  CSV: "csv",
};

/** A small DOM to Markdown pass for the elements the docs actually use. */
function toMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").replace(/\s+/g, " ");
  }
  if (!(node instanceof HTMLElement)) return "";
  if (node.matches(".docs-code-head, .docs-code-hl, button, svg, [aria-hidden='true']")) return "";

  const kids = () => Array.from(node.childNodes).map(toMarkdown).join("");
  const tag = node.tagName.toLowerCase();

  switch (tag) {
    case "h1":
      return `\n\n# ${kids().trim()}\n\n`;
    case "h2":
      return `\n\n## ${kids().trim()}\n\n`;
    case "h3":
      return `\n\n### ${kids().trim()}\n\n`;
    case "h4":
      return `\n\n#### ${kids().trim()}\n\n`;
    case "p":
      return `\n\n${kids().trim()}\n\n`;
    case "br":
      return "\n";
    case "strong":
    case "b": {
      const t = kids().trim();
      return t ? `**${t}**` : "";
    }
    case "em":
    case "i": {
      const t = kids().trim();
      return t ? `_${t}_` : "";
    }
    case "code":
      return node.closest("pre") ? kids() : `\`${node.textContent ?? ""}\``;
    case "pre": {
      const src = node.querySelector("code[data-docs-src]") ?? node.querySelector("code") ?? node;
      const label = node.querySelector(".docs-code-head span")?.textContent ?? "";
      const fence = FENCE_LANG[label] ?? "";
      return `\n\n\`\`\`${fence}\n${(src.textContent ?? "").replace(/\n+$/, "")}\n\`\`\`\n\n`;
    }
    case "a": {
      const t = kids().trim();
      const href = node.getAttribute("href") ?? "";
      if (!href) return t;
      const abs = href.startsWith("#")
        ? `${pageUrl()}${href}`
        : href.startsWith("/")
          ? `${window.location.origin}${href}`
          : href;
      return `[${t}](${abs})`;
    }
    case "ul":
    case "ol": {
      const items = Array.from(node.children).filter((c) => c.tagName === "LI");
      const lines = items.map((li, i) => {
        const marker = tag === "ol" ? `${i + 1}.` : "-";
        const text = Array.from(li.childNodes)
          .map(toMarkdown)
          .join("")
          .trim()
          .replace(/\n{2,}/g, "\n")
          .replace(/\n/g, "\n   ");
        return `${marker} ${text}`;
      });
      return `\n\n${lines.join("\n")}\n\n`;
    }
    case "table": {
      const rows = Array.from(node.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.children).map((c) =>
          Array.from(c.childNodes).map(toMarkdown).join("").trim().replace(/\|/g, "\\|")
        )
      );
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
      const [head, ...rest] = rows;
      return `\n\n${[line(head), line(head.map(() => "---")), ...rest.map(line)].join("\n")}\n\n`;
    }
    case "figure":
    case "div":
    case "section":
    case "figcaption":
    case "dl":
    case "dt":
    case "dd": {
      const inner = kids().trim();
      return inner ? `\n\n${inner}\n\n` : "";
    }
    case "span": {
      // Flow cards are built from block spans; keep their lines apart.
      const block = getComputedStyle(node).display === "block";
      const inner = kids();
      return block ? `\n${inner.trim()}\n` : inner;
    }
    default:
      return kids();
  }
}

function pageMarkdown(title: string, lede?: string) {
  const root = proseRoot();
  const body = root ? toMarkdown(root) : "";
  return [`# ${title}`, lede, body.trim(), `Source: ${pageUrl()}`]
    .filter(Boolean)
    .join("\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type Kind = "text" | "markdown" | "link";

const OPTIONS: { kind: Kind; title: string; body: string; Icon: typeof PageIcon }[] = [
  { kind: "text", title: "Copy page", body: "Plain text, for notes or an AI chat", Icon: PageIcon },
  { kind: "markdown", title: "Copy as Markdown", body: "Keeps headings, lists and code", Icon: MarkdownIcon },
  { kind: "link", title: "Copy link", body: "The address of this page", Icon: LinkIcon },
];

const DONE_LABEL: Record<Kind, string> = {
  text: "Copied",
  markdown: "Copied",
  link: "Link copied",
};

export function CopyPageButton({ title, lede }: { title: string; lede?: string }) {
  const pathname = usePathname();
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === pathname;
  const [done, setDone] = useState<Kind | null>(null);
  const timer = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpenFor(null), []);
  useDismiss(wrapRef, open, close);

  const copy = async (kind: Kind) => {
    const text =
      kind === "link" ? pageUrl() : kind === "markdown" ? pageMarkdown(title, lede) : pageText(title, lede);
    setOpenFor(null);
    try {
      await navigator.clipboard.writeText(text);
      setDone(kind);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(null), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Tab") {
      close();
    }
  };

  const openMenu = (focusFirst: boolean) => {
    setOpenFor(pathname);
    if (focusFirst) {
      window.requestAnimationFrame(() =>
        menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
      );
    }
  };

  const segment =
    "inline-flex h-10 items-center border border-line text-mute transition-colors hover:bg-surface hover:text-foreground focus-visible:z-10 lg:h-8";

  return (
    <div ref={wrapRef} className="relative inline-flex shrink-0">
      <button
        type="button"
        onClick={() => copy("text")}
        className={`${segment} gap-1.5 rounded-l-full pl-3 pr-2.5 text-[13px] font-medium`}
        aria-label={done ? DONE_LABEL[done] : "Copy page as plain text"}
      >
        {done ? <CheckIcon /> : <CopyIcon />}
        <span aria-live="polite">{done ? DONE_LABEL[done] : "Copy page"}</span>
      </button>
      <button
        type="button"
        onClick={() => (open ? close() : openMenu(false))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openMenu(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More copy options"
        className={`${segment} -ml-px w-10 justify-center rounded-r-full lg:w-8 ${open ? "bg-surface text-foreground" : ""}`}
      >
        <ChevronDownIcon className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Copy options"
          onKeyDown={onMenuKey}
          className="absolute right-0 top-full z-30 mt-2 w-[268px] rounded-2xl border border-line bg-panel p-1.5 shadow-pop transition-[opacity,transform] duration-150 starting:opacity-0 motion-safe:starting:-translate-y-1"
        >
          {OPTIONS.map(({ kind, title: t, body, Icon }) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => copy(kind)}
              className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-surface focus-visible:bg-surface focus-visible:outline-none"
            >
              <span className="mt-px grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line text-soft">
                <Icon />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] leading-snug text-foreground">{t}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-mute">{body}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
