import type { MetadataRoute } from "next";

const SITE = "https://hushd.net";

/** Every public page. Add a page here when it ships. */
const PAGES: { path: string; priority: number }[] = [{ path: "/", priority: 1 }];

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map(({ path, priority }) => ({ url: `${SITE}${path === "/" ? "" : path}`, priority }));
}
