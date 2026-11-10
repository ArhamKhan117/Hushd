import type { Metadata } from "next";

export const metadata: Metadata = { title: "Prove" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
