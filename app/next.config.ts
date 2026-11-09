import type { NextConfig } from "next";
import path from "node:path";
import { CSP_REPORT_ONLY } from "./csp.config.mjs";

/**
 * Vercel builds this package as the Root Directory (`app`); tracing stays inside the
 * monorepo so workspace packages resolve.
 */
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, ".."),
  // a second dev server beside the first needs its own build directory (NEXT_DIST_DIR=.next-3301)
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  poweredByHeader: false,
  // The SDK and protocol packages ship TypeScript source; Next compiles them.
  transpilePackages: ["@hushd/sdk", "@hushd/protocol", "@hushd/mcp"],
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
  webpack: (config) => {
    // snarkjs and circomlibjs reach for Node modules the browser never needs.
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, net: false, tls: false, readline: false, os: false };
    // The workspace packages use NodeNext ".js" specifiers for their ".ts" sources.
    config.resolve.extensionAlias = { ...(config.resolve.extensionAlias || {}), ".js": [".ts", ".tsx", ".js"] };
    // web-worker's Node shim (under snarkjs) imports a module by a computed name; harmless.
    config.ignoreWarnings = [...(config.ignoreWarnings || []), { module: /web-worker/, message: /Critical dependency/ }];
    return config;
  },
};

export default nextConfig;
