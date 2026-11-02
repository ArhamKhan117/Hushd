import type { MetadataRoute } from "next";

/** Install metadata: name, icons and colours, so a saved shortcut opens the app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Hushd",
    short_name: "Hushd",
    description: "A private OTC desk run by AI agents on NEAR.",
    start_url: "/app",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/favicon.png", sizes: "512x512", type: "image/png" },
      { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
