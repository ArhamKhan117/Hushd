import type { MetadataRoute } from "next";

const SITE = "https://hushd.net";

/** Every public page. Add a page here when it ships. */
const PAGES: { path: string; priority: number }[] = [
  { path: "/", priority: 1 },
  { path: "/app", priority: 0.9 },
  { path: "/docs", priority: 0.9 },
  { path: "/agents", priority: 0.8 },
  { path: "/sdk", priority: 0.8 },
  { path: "/verify", priority: 0.7 },
  { path: "/transparency", priority: 0.7 },
  { path: "/docs/quickstart", priority: 0.8 },
  { path: "/docs/desk", priority: 0.7 },
  { path: "/docs/packages", priority: 0.7 },
  { path: "/docs/proofs", priority: 0.7 },
  { path: "/docs/agents", priority: 0.7 },
  { path: "/docs/x402", priority: 0.6 },
  { path: "/docs/makers", priority: 0.6 },
  { path: "/docs/sdk", priority: 0.6 },
  { path: "/docs/privacy-model", priority: 0.6 },
  { path: "/docs/threat-model", priority: 0.6 },
  { path: "/docs/contracts", priority: 0.6 },
  { path: "/security", priority: 0.4 },
  { path: "/privacy", priority: 0.3 },
  { path: "/terms", priority: 0.3 },
  { path: "/cookies", priority: 0.2 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(({ path, priority }) => ({ url: `${SITE}${path === "/" ? "" : path}`, priority }));
}
