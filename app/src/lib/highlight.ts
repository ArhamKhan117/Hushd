/**
 * Tiny dependency-free syntax highlighter for the code we show (TypeScript /
 * JavaScript, JSON, shell). Returns HTML with `tok-*` spans; colours live in
 * globals.css so they follow light and dark. Input is escaped first, so it is
 * safe to inject.
 */

export type CodeLang = "ts" | "js" | "json" | "bash" | "sh" | "text";

const KEYWORDS = new Set([
  "import", "from", "export", "default", "const", "let", "var", "await", "async",
  "function", "return", "if", "else", "for", "of", "in", "new", "try", "catch",
  "throw", "type", "interface", "extends", "as", "class", "while", "break",
  "continue", "switch", "case", "typeof", "void", "yield", "static", "readonly",
]);
const LITERALS = new Set(["true", "false", "null", "undefined", "this"]);

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const span = (cls: string, s: string) => `<span class="tok-${cls}">${esc(s)}</span>`;

function highlightTs(code: string): string {
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_]*(?:\.\d+)?n?\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=<>+\-*/!?&|%^~@]+)|(\s+)|([\s\S])/g;
  let out = "";
  let m: RegExpExecArray | null;
  let prevWord = "";
  while ((m = re.exec(code))) {
    const [tok, com, str, num, word, punc, ws] = m;
    if (com) out += span("com", com);
    else if (str) out += span("str", str);
    else if (num) out += span("num", num);
    else if (word) {
      const rest = code.slice(re.lastIndex);
      if (KEYWORDS.has(word)) out += span("kw", word);
      else if (LITERALS.has(word)) out += span("lit", word);
      else if (/^\s*\(/.test(rest)) out += span("fn", word);
      else if (/^[A-Z][A-Z0-9_]+$/.test(word)) out += span("const", word);
      else if (/^[A-Z]/.test(word)) out += span("type", word);
      else if (/^\s*:/.test(rest) && prevWord !== "?") out += span("prop", word);
      else out += esc(word);
      prevWord = word;
    } else if (punc) out += span("punc", punc);
    else if (ws) out += ws;
    else out += esc(tok);
  }
  return out;
}

function highlightJson(code: string): string {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(\b-?\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\],:])|(\s+)|([\s\S])/g;
  let out = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const [tok, str, colon, num, lit, punc, ws] = m;
    if (str) out += colon ? span("prop", str) + span("punc", colon) : span("str", str);
    else if (num) out += span("num", num);
    else if (lit) out += span("lit", lit);
    else if (punc) out += span("punc", punc);
    else if (ws) out += ws;
    else out += esc(tok);
  }
  return out;
}

function highlightShell(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      if (/^\s*#/.test(line)) return span("com", line);
      const parts = line.match(/("[^"]*"|'[^']*'|\s+|[^\s]+)/g) ?? [];
      let first = true;
      return parts
        .map((p) => {
          if (/^\s+$/.test(p)) return p;
          if (/^["']/.test(p)) return span("str", p);
          if (first) {
            first = false;
            if (p === "$") {
              first = true;
              return span("punc", p);
            }
            return span("fn", p);
          }
          if (/^--?[\w-]+/.test(p)) return span("kw", p);
          if (/^@?[\w.-]+\/[\w.@-]+$/.test(p) || /^@[\w-]+/.test(p)) return span("str", p);
          return esc(p);
        })
        .join("");
    })
    .join("\n");
}

/** Guess a language from content when none is given. */
export function guessLang(code: string): CodeLang {
  const t = code.trim();
  if (/^[{[]/.test(t) && /"\s*:/.test(t)) return "json";
  if (/^(npm|pnpm|yarn|npx|bun|curl|cd|git|near|cargo|export|\$)\b/m.test(t) && !/\bimport\b|\bconst\b/.test(t))
    return "bash";
  if (/\b(import|const|let|await|function|=>)\b/.test(t)) return "ts";
  if (/^\s*(export\s+)?(interface|type|enum|declare)\s+[A-Z]/m.test(t)) return "ts";
  return "text";
}

export function highlight(code: string, lang?: CodeLang): string {
  const l = lang ?? guessLang(code);
  if (l === "ts" || l === "js") return highlightTs(code);
  if (l === "json") return highlightJson(code);
  if (l === "bash" || l === "sh") return highlightShell(code);
  return esc(code);
}
