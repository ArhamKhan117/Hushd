import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Check a proof",
  description: "Check a Hushd proof: a payment, a balance above a line, or desk volume, made for one named reader with an expiry, checked in your browser and by the pool contract on NEAR.",
  alternates: { canonical: "/verify" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
