import type { Metadata } from "next";
import { Landing } from "@/components/Landing";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

export default function Home() {
  return <Landing />;
}
