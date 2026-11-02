import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const alt = "Hushd: a private OTC desk run by AI agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const geist = (f: string) => join(process.cwd(), "node_modules/geist/dist/fonts/geist-sans", f);

const INK = "#000000";
const PAPER = "#F4F5F6";
const MUTE = "#3A3D42";
const IRIS = "#AEB0FF";

/** Rows of redaction bars across the foot of the card: the mark's motif, at scale. */
const BARS: { w: number; tone: string }[][] = [
  [{ w: 210, tone: MUTE }, { w: 330, tone: MUTE }, { w: 150, tone: IRIS }, { w: 260, tone: MUTE }, { w: 120, tone: MUTE }],
  [{ w: 300, tone: MUTE }, { w: 120, tone: MUTE }, { w: 240, tone: MUTE }, { w: 180, tone: MUTE }, { w: 230, tone: MUTE }],
];

/** Share card: an ink panel, the mark and wordmark, the headline in Geist Light, redaction bars below. */
export default async function OpenGraphImage() {
  const [light, medium] = await Promise.all([readFile(geist("Geist-Light.ttf")), readFile(geist("Geist-Medium.ttf"))]);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: INK, fontFamily: "Geist" }}>
        <div style={{ display: "flex", flexDirection: "column", padding: "64px 72px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ position: "relative", width: 44, height: 44, borderRadius: 13.75, background: PAPER, display: "flex" }}>
              <div style={{ position: "absolute", left: 9.6, top: 15.1, width: 24.75, height: 6.2, borderRadius: 3.1, background: INK, display: "flex" }} />
              <div style={{ position: "absolute", left: 9.6, top: 24.75, width: 15.1, height: 6.2, borderRadius: 3.1, background: INK, display: "flex" }} />
            </div>
            <div style={{ color: PAPER, fontSize: 30, fontWeight: 500, letterSpacing: "-0.015em", display: "flex" }}>Hushd</div>
          </div>
          <div
            style={{
              marginTop: 44,
              fontSize: 82,
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
        <div style={{ display: "flex", flexDirection: "column", gap: 22, marginTop: "auto", padding: "0 72px 64px" }}>
          {BARS.map((row, i) => (
            <div key={i} style={{ display: "flex", gap: 22 }}>
              {row.map((b, j) => (
                <div key={j} style={{ width: b.w, height: 26, borderRadius: 13, background: b.tone, display: "flex" }} />
              ))}
            </div>
          ))}
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
