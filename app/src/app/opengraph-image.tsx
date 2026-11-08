import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Hushd: a private OTC desk run by AI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const geist = (f: string) => join(process.cwd(), "node_modules/geist/dist/fonts/geist-sans", f);

const INK = "#08090A";
const PAPER = "#F4F5F6";
const STEEL = "#8E97A4";
const FAINT = "#5B6068";
const RULE = "#33363B";

// the mark (components/Logo): a coin cut on a slant, its halves slid past each other
const TOP = "M5.1 15.2H23.1Q24.3 15.2 24.3 14A10.2 10.2 0 0 0 3.9 14Q3.9 15.2 5.1 15.2Z";
const BOTTOM = "M8.9 16.8H26.9Q28.1 16.8 28.1 18A10.2 10.2 0 0 1 7.7 18Q7.7 16.8 8.9 16.8Z";

function Mark({ size, top, bottom }: { size: number; top: string; bottom: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <g transform="rotate(-35 16 16)">
        <path d={TOP} fill={top} />
        <path d={BOTTOM} fill={bottom} />
      </g>
    </svg>
  );
}

/** A crop mark at one corner of the card, as on the site's panels. */
function Crop({ x, y, dx, dy }: { x: number; y: number; dx: 1 | -1; dy: 1 | -1 }) {
  return (
    <div style={{ position: "absolute", left: x, top: y, width: 1, height: 1, display: "flex" }}>
      <div style={{ position: "absolute", left: dx === 1 ? 0 : -22, top: 0, width: 22, height: 1, background: RULE, display: "flex" }} />
      <div style={{ position: "absolute", left: 0, top: dy === 1 ? 0 : -22, width: 1, height: 22, background: RULE, display: "flex" }} />
    </div>
  );
}

/** Share card: ink, the mark and name, the headline in Geist Light, the mark at scale, crop marks at the corners. */
export default async function OpenGraphImage() {
  const [light, medium] = await Promise.all([readFile(geist("Geist-Light.ttf")), readFile(geist("Geist-Medium.ttf"))]);

  return new ImageResponse(
    (
      <div style={{ position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column", background: INK, fontFamily: "Geist", overflow: "hidden" }}>
        <div style={{ position: "absolute", right: -120, top: 70, display: "flex", opacity: 0.16 }}>
          <Mark size={620} top={PAPER} bottom={STEEL} />
        </div>
        <Crop x={36} y={36} dx={1} dy={1} />
        <Crop x={1164} y={36} dx={-1} dy={1} />
        <Crop x={36} y={594} dx={1} dy={-1} />
        <Crop x={1164} y={594} dx={-1} dy={-1} />
        <div style={{ display: "flex", flexDirection: "column", padding: "72px 80px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Mark size={46} top={PAPER} bottom={STEEL} />
            <div style={{ color: PAPER, fontSize: 30, fontWeight: 500, letterSpacing: "-0.015em", display: "flex" }}>Hushd</div>
          </div>
          <div
            style={{
              marginTop: 56,
              fontSize: 84,
              lineHeight: 1.02,
              fontWeight: 300,
              letterSpacing: "-0.028em",
              color: PAPER,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <span style={{ display: "flex" }}>Private OTC,</span>
            <span style={{ display: "flex" }}>run by agents</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: "auto", padding: "0 80px 72px", color: FAINT, fontSize: 24, fontWeight: 300 }}>
          <span style={{ display: "flex", color: STEEL }}>01</span>
          <span style={{ display: "flex", width: 40, height: 1, background: RULE }} />
          <span style={{ display: "flex" }}>A private OTC desk on NEAR</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Geist", data: light, weight: 300, style: "normal" },
        { name: "Geist", data: medium, weight: 500, style: "normal" },
      ],
    },
  );
}
