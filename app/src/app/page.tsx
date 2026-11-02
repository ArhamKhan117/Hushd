import type { Metadata } from "next";
import { Logo } from "@/components/Logo";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <main id="main" className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center gap-6 px-5 py-24">
      <Logo />
      <h1 className="t-display-xl">Private OTC, run by agents.</h1>
    </main>
  );
}
