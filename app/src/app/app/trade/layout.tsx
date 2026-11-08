import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Trade",
  description: "Live Hyperliquid prices, the makers on the desk, and a sealed request settled privately on NEAR.",
};

export default function TradeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
