import type { ReactNode } from "react";

/** A small ring in the text colour. Still under prefers-reduced-motion. */
export function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-75 motion-reduce:animate-none ${className}`}
    />
  );
}

/**
 * A button's label that turns into a spinner (and `busyText`, when given) while
 * `busy`, without the button changing width: both labels sit in one grid cell
 * and the hidden one keeps its space. Put it inside the button and set the
 * button's `aria-busy` and `disabled` as usual. `start` lines both up at the left,
 * for a text link: centred, the shorter label would sit indented from the text above.
 */
export function BusyLabel({ busy, busyText, start = false, children }: { busy: boolean; busyText?: ReactNode; start?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-grid items-center ${start ? "justify-items-start" : "justify-items-center"}`}>
      <span className={`col-start-1 row-start-1 inline-flex items-center gap-2 ${busy ? "invisible" : ""}`}>{children}</span>
      <span className={`col-start-1 row-start-1 inline-flex items-center gap-2 ${busy ? "" : "invisible"}`}>
        <Spinner />
        {busyText ?? <span className="sr-only">Working</span>}
      </span>
    </span>
  );
}
