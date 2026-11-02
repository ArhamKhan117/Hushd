import type { MetadataRoute } from "next";

const SITE = "https://hushd.net";

/** Crawlers may read the site, docs and app; the API stays out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: `${SITE}/sitemap.xml`,
    host: SITE,
  };
}
