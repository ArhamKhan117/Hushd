import type { NextConfig } from "next";
import path from "node:path";
import { CSP_REPORT_ONLY } from "./csp.config.mjs";

/**
 * Vercel builds this package as the Root Directory (`app`); tracing stays inside the
 * monorepo so workspace packages resolve.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, ".."),
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
  },
  // Every response gets the basics. The enforced CSP covers framing, plugins, <base>
  // and form targets; the fuller policy (script and connect sources, csp.config.mjs)
  // is sent Report-Only, so it is checked against real use before it is enforced.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
          },
          // production only: dev builds evaluate code for hot reload and would flood the console
          ...(process.env.NODE_ENV === "production" ? [{ key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY }] : []),
        ],
      },
    ];
  },
};

export default nextConfig;
