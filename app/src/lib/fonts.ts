import { Archivo } from "next/font/google";

/**
 * Expanded black, only for the footer's wordmark (`.hd-wordmark-word` reads --font-wide).
 * Declared for the root layout, so its @font-face ships in the site's stylesheet rather
 * than a stylesheet of its own that other pages would preload and not use. The file
 * itself is fetched only when the word first renders (no preload).
 */
export const wide = Archivo({ subsets: ["latin"], axes: ["wdth"], display: "swap", preload: false, variable: "--font-wide" });
