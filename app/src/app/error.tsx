"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Header } from "@/components/Header";
import { SealedField } from "@/components/ui/SealedField";
import { SealDots } from "@/components/ui/SealDots";

/**
 * Runtime error inside any page. Same frame as the 404: the marketing header,
 * one panel, a short line and a way out. The error itself stays in the
 * console; visitors only see a reference they can quote to us.
 */
export default function RouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="relative flex min-h-screen flex-col bg-panel text-foreground">
      <Header />

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 pb-4 pt-3 sm:px-7 sm:pb-7 sm:pt-6">
        <div className="hd-panel flex min-h-[calc(100svh-5rem)] flex-1 flex-col justify-end px-6 pb-10 pt-24 sm:px-12 sm:pb-14">
          <SealedField />
          <div className="relative max-w-[760px]">
            <p className="t-label inline-flex items-center gap-3">
              Something went wrong
              <span aria-hidden>
                <SealDots n={3} className="text-faint" />
              </span>
            </p>
            <h1 className="t-display-xl mt-5">This page hit an error</h1>
            <p className="mt-6 max-w-[46ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
              It is on our side, not yours. Try again, or head back home. If it
              keeps happening, write to{" "}
              <a
                href="mailto:hello@hushd.net"
                className="text-foreground underline decoration-line-strong underline-offset-4 hover:decoration-foreground"
              >
                hello@hushd.net
              </a>
              .
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
              <button type="button" onClick={() => unstable_retry()} className="btn btn-ink btn-lg">
                Try again
              </button>
              <Link href="/" className="btn btn-ghost btn-lg">
                Back to home
              </Link>
            </div>
            {error.digest && (
              <p className="tnum mt-6 text-[12.5px] text-faint">Reference {error.digest}</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
