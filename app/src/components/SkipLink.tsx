"use client";

/**
 * The first Tab stop on every page: jumps past the banner and navigation to the
 * page's own content. Every page has one <main>, so this finds it rather than
 * asking each page for an id.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="hd-skip"
      onClick={(e) => {
        const main = document.querySelector("main");
        if (!main) return;
        e.preventDefault();
        main.tabIndex = -1;
        main.focus();
      }}
    >
      Skip to content
    </a>
  );
}
