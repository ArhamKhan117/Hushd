import type { Metadata } from "next";
import { HushdProvider } from "@/lib/hushd/session";

export const metadata: Metadata = {
  title: { default: "App", template: "%s · Hushd" },
  description: "The Hushd desk: state a deal, get quotes matched in an enclave, settle privately on NEAR.",
  robots: { index: false, follow: true },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <HushdProvider>{children}</HushdProvider>;
}
