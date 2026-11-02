import { GeistSans } from "geist/font/sans";
import type { Metadata, Viewport } from "next";
import { CookieBanner } from "@/components/CookieBanner";
import { SkipLink } from "@/components/SkipLink";
import { ThemeProvider } from "@/components/ThemeProvider";
import { VercelAnalytics } from "@/components/VercelAnalytics";
import { DEVICE_BOOT_SCRIPT } from "@/lib/device";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

const siteTitle = "Hushd · Private OTC desk on NEAR";
const siteDescription =
  "A private OTC desk run by AI agents. State a deal in plain words, get quotes matched inside an enclave, settle privately, and prove one fact to one named reader.";

/**
 * Absolute URLs in link previews point at the live host. Open Graph and Twitter carry no title or
 * description here on purpose: Next fills them from each page's own title and
 * description, and the share image comes from opengraph-image.tsx. Pages set
 * their own canonical; one here would point every page at the home page.
 */
export const metadata: Metadata = {
  metadataBase: new URL("https://hushd.net"),
  title: {
    default: siteTitle,
    template: "%s · Hushd",
  },
  description: siteDescription,
  applicationName: "Hushd",
  authors: [{ name: "Hushd", url: "https://hushd.net" }],
  creator: "Hushd",
  keywords: ["Hushd", "private OTC", "NEAR", "zero-knowledge", "AI agents", "private settlement"],
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    siteName: "Hushd",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#08090a" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
  colorScheme: "dark light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`h-full antialiased ${GeistSans.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: DEVICE_BOOT_SCRIPT }} />
      </head>
      <body
        className="flex min-h-full flex-col bg-background text-foreground"
        style={{ fontFamily: "var(--font-geist-sans), system-ui, sans-serif" }}
      >
        <ThemeProvider>
          <SkipLink />
          {children}
          <CookieBanner />
        </ThemeProvider>
        <VercelAnalytics />
      </body>
    </html>
  );
}
