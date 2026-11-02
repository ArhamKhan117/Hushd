"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { CONSENT_KEY, getConsent, setConsent, subscribeConsent, type ConsentValue } from "@/lib/consent";

/**
 * The banner is in the server HTML with `hidden`, and this script right after
 * it shows it when this browser has made no choice yet, so it appears with the
 * first paint instead of after the app's JavaScript runs. React takes over from there.
 */
const REVEAL_SCRIPT = `(function(){try{var v=localStorage.getItem('${CONSENT_KEY}');if(v==='all'||v==='essential')return;var el=document.getElementById('hd-cookie');if(el)el.hidden=false}catch(e){}})()`;

export function CookieBanner() {
  // The server has no choice to read, so it renders the banner hidden ("set").
  const consent = useSyncExternalStore<ConsentValue | "set" | null>(subscribeConsent, getConsent, () => "set");
  // Closes at once even where storage refuses the write (private mode).
  const [closed, setClosed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hide = consent !== null || closed;
  // The head start may have shown it; React's state decides from here.
  useEffect(() => {
    if (ref.current) ref.current.hidden = hide;
  }, [hide]);

  const accept = (value: ConsentValue) => {
    setConsent(value);
    setClosed(true);
  };

  return (
    <>
    <div
      ref={ref}
      id="hd-cookie"
      hidden={hide}
      suppressHydrationWarning
      role="dialog"
      aria-label="Cookie consent"
      className="hd-cookie fixed bottom-3 left-3 right-3 z-50 sm:left-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
    >
      <div className="rounded-[20px] border border-line bg-panel/95 p-4 shadow-pop backdrop-blur-xl sm:p-5">
        <p className="text-[14px] text-foreground max-sm:hidden">Cookies</p>
        {/* A phone gets the short version, so the banner stays a strip, not a third of the screen. */}
        <p className="text-[13px] leading-relaxed text-mute sm:hidden">
          No ad or tracking cookies. Essential only keeps what the site needs. Accept all adds anonymous,
          cookieless page view counts.{" "}
          <Link href="/cookies" className="text-foreground underline underline-offset-2">
            More
          </Link>
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-mute max-sm:hidden">
          We set no ad or tracking cookies. Essential only keeps what the site
          needs to work. Accept all turns on anonymous page view counts, with
          no cookies.
          See{" "}
          <Link href="/cookies" className="text-foreground underline underline-offset-2">
            Cookies
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="text-foreground underline underline-offset-2">
            Privacy
          </Link>
          .
        </p>
        <div className="mt-3 flex gap-2 sm:mt-4">
          <button
            type="button"
            onClick={() => accept("essential")}
            className="btn btn-ghost btn-sm flex-1"
          >
            Essential only
          </button>
          <button
            type="button"
            onClick={() => accept("all")}
            className="btn btn-ink btn-sm flex-1"
          >
            Accept all
          </button>
        </div>
      </div>
    </div>
    <script dangerouslySetInnerHTML={{ __html: REVEAL_SCRIPT }} />
    </>
  );
}
