"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import { THEME_KEY, type ResolvedTheme, type ThemeChoice } from "@/lib/theme";

export type { ResolvedTheme, ThemeChoice };

function resolve(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function apply(resolved: ResolvedTheme) {
  const d = document.documentElement;
  d.dataset.theme = resolved;
  d.classList.toggle("dark", resolved === "dark");
  d.classList.toggle("light", resolved === "light");
}

const ThemeContext = createContext<{
  theme: ResolvedTheme;
  choice: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
  toggle: () => void;
}>({ theme: "light", choice: "system", setTheme: () => {}, toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [theme, setResolved] = useState<ResolvedTheme>("light");

  useEffect(() => {
    let saved: ThemeChoice = "system";
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === "light" || v === "dark") saved = v;
    } catch {
      /* storage unavailable */
    }
    const r = resolve(saved);
    // The head script normally stamps this before paint. When Next serves a
    // client-rendered error shell that script never runs, so stamp it here too.
    apply(r);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the saved theme lives only in the browser (the head script already painted it); React reads it once after mount
    setChoice(saved);
    setResolved(r);
  }, []);

  useEffect(() => {
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r = resolve("system");
      apply(r);
      setResolved(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const setTheme = useCallback((t: ThemeChoice) => {
    try {
      if (t === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
    const r = resolve(t);
    apply(r);
    setChoice(t);
    setResolved(r);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, choice, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
