import type { Metadata } from "next";

// a layout with pages below it keeps the template, or their titles lose " · Hushd"
export const metadata: Metadata = { title: { default: "Deals", template: "%s · Hushd" } };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
