/**
 * The favicon and app icons, from the mark in src/components/Logo.tsx:
 *
 *   node scripts/make-icons.mjs
 *
 * Writes public/favicon.svg (an ink tile that turns to paper on a dark browser),
 * the PNGs (16, 32, 180 full-bleed for iOS, 512) and src/app/favicon.ico (16, 32, 48),
 * rasterised by Playwright's Chromium so the PNGs match the SVG exactly.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = new URL("..", import.meta.url).pathname;
const TOP = "M5.1 15.2H23.1Q24.3 15.2 24.3 14A10.2 10.2 0 0 0 3.9 14Q3.9 15.2 5.1 15.2Z";
const BOTTOM = "M8.9 16.8H26.9Q28.1 16.8 28.1 18A10.2 10.2 0 0 1 7.7 18Q7.7 16.8 8.9 16.8Z";
const GLYPH = (top, bottom) =>
  `<g transform="translate(16 16) scale(0.78) translate(-16 -16) rotate(-35 16 16)"><path class="${top}" d="${TOP}"/><path class="${bottom}" d="${BOTTOM}"/></g>`;

// ink tile, paper and steel halves; on a dark browser the tile turns to paper
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.t{fill:#0B0C0E}.a{fill:#FFFFFF}.b{fill:#AAB1BC}@media (prefers-color-scheme: dark){.t{fill:#F4F5F6}.a{fill:#08090A}.b{fill:#5B6370}}</style><rect class="t" width="32" height="32" rx="8"/>${GLYPH("a", "b")}</svg>`;
writeFileSync(join(ROOT, "public/favicon.svg"), svg);

const raster = (rx) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>.t{fill:#0B0C0E}.a{fill:#FFFFFF}.b{fill:#AAB1BC}</style><rect class="t" width="32" height="32" rx="${rx}"/>${GLYPH("a", "b")}</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ colorScheme: "light" });
async function png(size, rx) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${raster(rx).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
const files = { "public/favicon-16.png": [16, 8], "public/favicon-32.png": [32, 8], "public/favicon.png": [512, 8], "src/app/icon.png": [512, 8], "public/apple-touch-icon.png": [180, 0] };
for (const [f, [size, rx]] of Object.entries(files)) writeFileSync(join(ROOT, f), await png(size, rx));

// a .ico of PNG images: header, one directory entry per size, then the images
const icons = [];
for (const s of [16, 32, 48]) icons.push({ s, data: await png(s, 8) });
const header = Buffer.alloc(6 + 16 * icons.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(icons.length, 4);
let offset = header.length;
icons.forEach(({ s, data }, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s, e);
  header.writeUInt8(s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
writeFileSync(join(ROOT, "src/app/favicon.ico"), Buffer.concat([header, ...icons.map((x) => x.data)]));
await browser.close();
console.log("wrote favicon.svg, favicon-16/32.png, favicon.png, icon.png, apple-touch-icon.png, favicon.ico");
