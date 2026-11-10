import type { Metadata } from "next";

/** The tab names the deal, as the page's own heading does. */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: /^\d+$/.test(id) ? `Deal #${id}` : "Deal" };
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
