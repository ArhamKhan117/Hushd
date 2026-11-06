import type { Metadata } from "next";
import { TransparencyView } from "@/components/transparency/TransparencyView";

export const metadata: Metadata = {
  title: "Transparency",
  description:
    "What anyone can see about Hushd, read live: the health of each service, what the service accounts hold, the pool's and the desk's counts on NEAR testnet, the contract accounts, and what stays private.",
  alternates: { canonical: "/transparency" },
};

export default function TransparencyPage() {
  return <TransparencyView />;
}
