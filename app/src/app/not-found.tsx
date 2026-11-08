import type { Metadata } from "next";
import Link from "next/link";
import { AppLink } from "@/components/AppLink";
import { Header } from "@/components/Header";
import { FlowField } from "@/components/ui/FlowField";
import { SealDots } from "@/components/ui/SealDots";
import type { CSSProperties } from "react";
import "@/styles/pages.css";

const rise = (d: number) => ({ "--d": d }) as CSSProperties;

// Its own tab title, and noindex alone (the root layout's index, follow would sit next to it).
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <div className="relative flex min-h-screen flex-col bg-panel text-foreground">
      <Header />

      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col px-4 pb-4 pt-3 sm:px-7 sm:pb-7 sm:pt-6">
        <div className="hd-crop flex flex-1 flex-col">
          <div className="hd-panel hd-sheen flex min-h-[calc(100svh-5rem)] flex-1 flex-col justify-end border border-line px-6 pb-10 pt-24 sm:px-12 sm:pb-14">
            <FlowField />
            <span aria-hidden className="pg-404" />
            <div className="relative max-w-[760px]">
              <p className="t-label pg-rise inline-flex items-center gap-3">
                Error 404
                <span aria-hidden>
                  <SealDots n={3} className="text-faint" />
                </span>
              </p>
              <h1 style={rise(1)} className="t-display-xl pg-rise mt-5">
                This page is not on the record
              </h1>
              <p style={rise(2)} className="pg-rise mt-6 max-w-[46ch] text-[16px] leading-relaxed text-soft sm:text-[17px]">
                The link may be old, or the page moved. Everything else is right
                where you left it.
              </p>
              <div style={rise(3)} className="pg-rise mt-8 flex flex-wrap gap-2">
                <Link href="/" className="btn btn-ink btn-lg">
                  Back to home
                </Link>
                <AppLink href="/app" className="btn btn-ghost btn-lg">
                  Open app
                </AppLink>
                <Link href="/docs" className="btn btn-quiet btn-lg">
                  Read the docs
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
