"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { guessLang, highlight, type CodeLang } from "@/lib/highlight";
import { tabIndent } from "@/components/ui/CodeBlock";

/* Same glyphs as CopyButton in components/ui/CodeBlock. */
const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" stroke="currentColor" stroke-width="1.5"/></svg>`;
/* A glyph for the header bar: a prompt for the terminal, braces for JSON, a page for the rest. */
const GLYPH: Record<string, string> = {
  Terminal: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7l5 5-5 5M12.5 17.5H19" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  JSON: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 4.5H8a2 2 0 0 0-2 2V10a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3.5a2 2 0 0 0 2 2h1M15 4.5h1a2 2 0 0 1 2 2V10a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3.5a2 2 0 0 1-2 2h-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  page: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.75h6.5L18.25 8.5v10.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-13.5a1.5 1.5 0 0 1 1.5-1.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.25 4v4.5h4.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
};
const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/* The header strip sits in space the pre reserves in CSS (.docs-prose pre), so
   adding it after hydration never shifts the page. Button matches CopyButton. */
const HEAD_CLASS =
  "docs-code-head absolute inset-x-0 top-0 flex h-11 items-center justify-between gap-3 whitespace-normal pl-5 pr-2 text-[12.5px] text-mute";
const BUTTON_CLASS =
  "hd-tap inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium text-mute transition-colors hover:bg-surface-2 hover:text-foreground";

const LANG_LABEL: Record<CodeLang, string> = {
  ts: "TypeScript",
  js: "JavaScript",
  json: "JSON",
  bash: "Terminal",
  sh: "Terminal",
  text: "Text",
};

function langOf(code: HTMLElement | null, src: string): CodeLang {
  const hinted = `${code?.className ?? ""} ${code?.dataset.lang ?? ""}`.match(
    /(?:language-)?\b(ts|tsx|typescript|js|javascript|json|bash|sh|shell|text)\b/
  )?.[1];
  if (hinted) {
    if (/^(tsx?|typescript)$/.test(hinted)) return "ts";
    if (/^(js|javascript)$/.test(hinted)) return "js";
    if (/^(sh|shell|bash)$/.test(hinted)) return "bash";
    return hinted as CodeLang;
  }
  const guessed = guessLang(src);
  // guessLang keys on statements; type-only snippets (interfaces, signatures)
  // are TypeScript too.
  if (
    guessed === "text" &&
    (/^\s*(export\s+)?(interface|type|enum|declare|abstract\s+class|class)\s+[A-Z]\w*/m.test(src) ||
      /\w\??:\s*(string|number|bigint|boolean|Uint8Array|Promise<|readonly|`)/.test(src))
  ) {
    return "ts";
  }
  return guessed;
}

function labelOf(lang: CodeLang, src: string) {
  if (lang === "text") {
    const lines = src.trim().split("\n");
    if (lines.length > 1 && lines.every((l) => l.includes(","))) return "CSV";
  }
  return LANG_LABEL[lang];
}

/**
 * Adds highlighting and a copy button to the docs' code blocks. The original `<code>`
 * stays in React's tree (hidden by CSS); the highlighted version is a sibling this
 * component inserts and removes on navigation, so React never sees a node it did not make.
 */
export function DocsCopyEnhancer() {
  const pathname = usePathname();

  useEffect(() => {
    const pres = document.querySelectorAll<HTMLPreElement>(".docs-prose pre");
    const undo: (() => void)[] = [];

    pres.forEach((pre) => {
      if (pre.dataset.enhanced) return;
      const code = pre.querySelector<HTMLElement>(":scope > code");
      const src = (code ?? pre).textContent ?? "";
      const lang = langOf(code, src);

      // Highlighted twin, indents as tabs so Geist's proportional spaces align.
      let twin: HTMLElement | null = null;
      if (code) {
        twin = document.createElement("code");
        twin.className = "docs-code-hl";
        twin.innerHTML = highlight(tabIndent(src), lang);
        code.setAttribute("data-docs-src", "");
        code.after(twin);
      }

      const head = document.createElement("div");
      head.className = HEAD_CLASS;
      const name = labelOf(lang, src);
      const label = document.createElement("span");
      label.className = "docs-code-label";
      const glyph = document.createElement("span");
      glyph.className = "docs-code-glyph";
      glyph.setAttribute("aria-hidden", "true");
      glyph.innerHTML = GLYPH[name] ?? GLYPH.page;
      const text = document.createElement("span");
      text.className = "min-w-0 truncate";
      text.textContent = name;
      label.append(glyph, text);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = BUTTON_CLASS;
      btn.setAttribute("aria-label", "Copy code");
      btn.innerHTML = `${COPY_ICON}<span>Copy</span>`;
      head.append(label, btn);
      pre.prepend(head);

      let timer = 0;
      const onClick = async () => {
        try {
          await navigator.clipboard.writeText(src);
          btn.innerHTML = `${CHECK_ICON}<span aria-live="polite">Copied</span>`;
          btn.setAttribute("aria-label", "Copied");
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            btn.innerHTML = `${COPY_ICON}<span>Copy</span>`;
            btn.setAttribute("aria-label", "Copy code");
          }, 1600);
        } catch {
          /* clipboard unavailable */
        }
      };
      btn.addEventListener("click", onClick);
      pre.dataset.enhanced = "1";

      undo.push(() => {
        window.clearTimeout(timer);
        btn.removeEventListener("click", onClick);
        head.remove();
        twin?.remove();
        code?.removeAttribute("data-docs-src");
        delete pre.dataset.enhanced;
      });
    });

    return () => undo.forEach((fn) => fn());
  }, [pathname]);

  return null;
}
