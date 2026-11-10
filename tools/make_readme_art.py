"""README art for Hushd: hero lockups and three diagrams, drawn with Pillow.

    python -m tools.make_readme_art            write every image to assets/readme/
    python -m tools.make_readme_art --check    report what would change, write nothing

Why it is built this way (each rule exists because the alternative was measured broken):
- Colours come from the app's own CSS tokens (app/src/app/globals.css), parsed here, so a
  figure cannot disagree with the product. The accent is the graphite steel `--accent`.
- Every other light colour is the fixed diagram palette, so figures read as one set.
- The text accent is derived (`readable_accent`) to clear 4.5:1 on both the card and the
  tinted band; the raw accent is decorative only. `audit` runs first and writes nothing on
  a failure.
- Translucent washes are pre-composited (`blend`): ImageDraw overwrites alpha.
- Drawn at 2x and reduced with LANCZOS at 960 wide; canvas heights are even.
- One `flow` pass feeds both measurement and drawing; gutters widen to fit arrow labels.
- Type is Geist, the app's own face, from node_modules (run `pnpm install` first); a missing
  font exits 2 rather than letting Pillow substitute one (a substitute invalidates every measurement).
"""

from __future__ import annotations

import colorsys
import hashlib
import io
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "readme"
MARK = ROOT / "app" / "src" / "app" / "icon.png"
TOKENS = ROOT / "app" / "src" / "app" / "globals.css"
# Geist, the app's own typeface (OFL), from the `geist` package the app already installs
_GEIST = next(iter(sorted((ROOT / "node_modules" / ".pnpm").glob("geist@*/node_modules/geist/dist/fonts"))), ROOT / "missing-geist")
FONTS = {
    "regular": str(_GEIST / "geist-sans" / "Geist-Regular.ttf"),
    "semibold": str(_GEIST / "geist-sans" / "Geist-SemiBold.ttf"),
    "bold": str(_GEIST / "geist-sans" / "Geist-Bold.ttf"),
    "mono": str(_GEIST / "geist-mono" / "GeistMono-Regular.ttf"),
}

SCALE = 2
FIGURE_WIDTH = 960


def px(value: float) -> int:
    return int(round(value * SCALE))


# ---------- colour ----------


def parse_hex(colour: str) -> tuple[int, int, int]:
    text = colour.strip().lstrip("#")
    if len(text) != 6:
        raise ValueError(f"expected #RRGGBB, got {colour!r}")
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def relative_luminance(colour: str) -> float:
    def channel(value: int) -> float:
        c = value / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in parse_hex(colour))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(foreground: str, background: str) -> float:
    a, b = relative_luminance(foreground), relative_luminance(background)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def meets_aa(foreground: str, background: str) -> bool:
    return contrast_ratio(foreground, background) >= 4.5


def blend(top: str, bottom: str, alpha: float) -> str:
    t, b = parse_hex(top), parse_hex(bottom)
    return "#%02X%02X%02X" % tuple(round(t[i] * alpha + b[i] * (1 - alpha)) for i in range(3))


def readable_accent(accent: str, *surfaces: str) -> str:
    """Nearest colour to `accent` (same hue and saturation) that clears AA on every surface."""
    hue, saturation, value = colorsys.rgb_to_hsv(*[c / 255 for c in parse_hex(accent)])

    def at(v: float) -> str:
        return "#%02X%02X%02X" % tuple(round(c * 255) for c in colorsys.hsv_to_rgb(hue, saturation, v))

    def passes(colour: str) -> bool:
        return all(meets_aa(colour, s) for s in surfaces)

    if passes(accent):
        return accent
    for step in range(1, 46):
        for direction in (-1, 1):
            v = value + direction * step * 0.02
            if 0.0 <= v <= 1.0 and passes(at(v)):
                return at(v)
    return accent


def css_tokens() -> tuple[dict[str, str], dict[str, str]]:
    """The light (:root) and dark (.theme-dark) custom properties of the app."""
    css = TOKENS.read_text()

    def block(selector_pattern: str) -> dict[str, str]:
        match = re.search(selector_pattern + r"\s*\{(.*?)\n\}", css, re.S)
        if not match:
            raise SystemExit(f"ERROR: no {selector_pattern} block in {TOKENS}")
        return dict(re.findall(r"--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;", match.group(1)))

    return block(r"(?m)^:root,\s*\.theme-light"), block(r"(?m)^\.theme-dark")


LIGHT_TOKENS, DARK_TOKENS = css_tokens()
ACCENT = LIGHT_TOKENS["accent"].upper()
ACCENT_DARK = DARK_TOKENS["accent"].upper()
LIGHT_SURFACE = "#FAFAFB"
LIGHT_BAND = blend(ACCENT, LIGHT_SURFACE, 0.10)


@dataclass(frozen=True)
class Palette:
    name: str
    page: str
    surface: str
    surface_alt: str
    border: str
    border_strong: str
    text: str
    text_secondary: str
    text_muted: str
    accent: str
    accent_text: str
    band: str
    rule: str


LIGHT = Palette(
    name="light",
    page="#FFFFFF",
    surface=LIGHT_SURFACE,
    surface_alt="#F2F2F4",
    border="#DFDFE4",
    border_strong="#B9B9C2",
    text="#131316",
    text_secondary="#43434E",
    text_muted="#5F5F6B",
    accent=ACCENT,
    accent_text=readable_accent(ACCENT, LIGHT_SURFACE, LIGHT_BAND),
    band=LIGHT_BAND,
    rule="#E4E4E9",
)

_dark_surface = DARK_TOKENS["surface"].upper()
_dark_band = blend(ACCENT_DARK, _dark_surface, 0.10)
DARK = Palette(
    name="dark",
    page=DARK_TOKENS["background"].upper(),
    surface=_dark_surface,
    surface_alt=DARK_TOKENS["surface-2"].upper(),
    border=DARK_TOKENS["line"].upper(),
    border_strong=DARK_TOKENS["line-strong"].upper(),
    text=DARK_TOKENS["foreground"].upper(),
    text_secondary=DARK_TOKENS["soft"].upper(),
    text_muted=DARK_TOKENS["mute"].upper(),
    accent=ACCENT_DARK,
    accent_text=readable_accent(ACCENT_DARK, _dark_surface, _dark_band),
    band=_dark_band,
    rule=DARK_TOKENS["line"].upper(),
)


def audit(palette: Palette) -> list[str]:
    problems = []
    for surface_name, surface in (("card", palette.surface), ("band", palette.band)):
        for role in ("text", "text_secondary", "text_muted", "accent_text"):
            colour = getattr(palette, role)
            ratio = contrast_ratio(colour, surface)
            mark = "ok  " if ratio >= 4.5 else "FAIL"
            line = f"  {mark}  {palette.name:5} {role:15} {colour} on the {surface_name} {surface}  {ratio:5.2f}:1"
            print(line)
            if ratio < 4.5:
                problems.append(line.strip())
    return problems


# ---------- type ----------

_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(kind: str, size: int) -> ImageFont.FreeTypeFont:
    key = (kind, size)
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(FONTS[kind], size * SCALE)
    return _font_cache[key]


def line_height(f: ImageFont.FreeTypeFont) -> int:
    ascent, descent = f.getmetrics()
    return int((ascent + descent) * 1.32)


def wrap(text: str, f: ImageFont.FreeTypeFont, max_width: int, draw: ImageDraw.ImageDraw) -> list[str]:
    if not text:
        return []
    lines, words = [], text.split()
    current = words[0]
    for word in words[1:]:
        candidate = f"{current} {word}"
        if draw.textlength(candidate, font=f) <= max_width:
            current = candidate
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def even(height: int) -> int:
    return height + (height % SCALE)


def finish(image: Image.Image) -> Image.Image:
    return image.resize((image.width // SCALE, image.height // SCALE), Image.LANCZOS)


# ---------- the shared header ----------


class Figure:
    PAD = 30

    def __init__(self, title: str, subtitle: str):
        self.title = title
        self.subtitle = subtitle
        self.width = px(FIGURE_WIDTH)
        self._probe = ImageDraw.Draw(Image.new("RGBA", (8, 8)))
        self.f_sub = font("regular", 9)

    def header_left(self) -> int:
        return px(self.PAD) + px(30) + px(12)

    def subtitle_width(self) -> int:
        return self.width - self.header_left() - px(self.PAD)

    def header_height(self) -> int:
        lines = max(1, len(wrap(self.subtitle, self.f_sub, self.subtitle_width(), self._probe)))
        return px(self.PAD) + line_height(font("bold", 18)) + lines * line_height(self.f_sub) + px(20)

    def draw_header(self, image: Image.Image, palette: Palette) -> None:
        draw = ImageDraw.Draw(image)
        top = left = px(self.PAD)
        mark = Image.open(MARK).convert("RGBA").resize((px(30), px(30)), Image.LANCZOS)
        image.paste(mark, (left, top), mark)
        draw.text((self.header_left(), top - px(2)), self.title, font=font("bold", 18), fill=palette.text)
        y = top - px(2) + line_height(font("bold", 18))
        for line in wrap(self.subtitle, self.f_sub, self.subtitle_width(), draw):
            draw.text((self.header_left(), y), line, font=self.f_sub, fill=palette.text_muted)
            y += line_height(self.f_sub)
        rule_y = self.header_height() - px(11)
        draw.line([(left, rule_y), (self.width - left, rule_y)], fill=palette.rule, width=SCALE)


# ---------- panels and columns ----------


@dataclass
class Item:
    label: str
    note: str = ""
    mono: bool = False
    accent: bool = False


@dataclass
class Panel:
    title: str
    items: list[Item]
    subtitle: str = ""
    emphasis: bool = False
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0


@dataclass
class Columns(Figure):
    columns: list[list[Panel]] = field(default_factory=list)
    arrows: list[tuple[str, str, str]] = field(default_factory=list)
    PANEL_PAD = 15
    ITEM_GAP = 10
    PANEL_GAP = 14
    MIN_GUTTER = 26
    BULLET = 13

    def __init__(self, title: str, subtitle: str, columns: list[list[Panel]], arrows: list[tuple[str, str, str]]):
        super().__init__(title, subtitle)
        self.columns = columns
        self.arrows = arrows
        self.f_title = font("semibold", 12)
        self.f_label = font("semibold", 10)
        self.f_mono = font("mono", 9)
        self.f_note = font("regular", 9)
        self.f_arrow = font("regular", 8)

    def pad(self) -> int:
        return px(self.PANEL_PAD)

    def measure_gutter(self) -> int:
        needed = px(self.MIN_GUTTER)
        for _, _, label in self.arrows:
            if label:
                needed = max(needed, int(self._probe.textlength(label, font=self.f_arrow)) + px(26))
        return needed

    def flow(self, panel: Panel, width: int):
        """Every line as (dx, dy, font, text, role, bullet), relative to the panel's padding."""
        inner = width - 2 * self.pad()
        out = []
        y = 0
        out.append((0, y, self.f_title, panel.title, "title", False))
        y += line_height(self.f_title)
        for line in wrap(panel.subtitle, self.f_sub, inner, self._probe):
            out.append((0, y, self.f_sub, line, "subtitle", False))
            y += line_height(self.f_sub)
        y += px(9)
        text_width = inner - px(self.BULLET)
        for index, item in enumerate(panel.items):
            if index:
                y += px(self.ITEM_GAP)
            f = self.f_mono if item.mono else self.f_label
            role = "label-accent" if item.accent else "label"
            for n, line in enumerate(wrap(item.label, f, text_width, self._probe)):
                out.append((px(self.BULLET), y, f, line, role, n == 0))
                y += line_height(f)
            for line in wrap(item.note, self.f_note, text_width, self._probe):
                out.append((px(self.BULLET), y, self.f_note, line, "note", False))
                y += line_height(self.f_note)
        return out

    def measure(self, panel: Panel, width: int) -> int:
        _, last_y, last_font, *_ = self.flow(panel, width)[-1]
        return self.pad() + last_y + line_height(last_font) + self.pad()

    def layout(self) -> int:
        gutter = self.measure_gutter()
        count = len(self.columns)
        column_width = (self.width - 2 * px(self.PAD) - gutter * (count - 1)) // count
        tallest = 0
        for c, column in enumerate(self.columns):
            x = px(self.PAD) + c * (column_width + gutter)
            y = self.header_height()
            for panel in column:
                panel.x, panel.y, panel.width = x, y, column_width
                panel.height = self.measure(panel, column_width)
                y += panel.height + px(self.PANEL_GAP)
            tallest = max(tallest, y - px(self.PANEL_GAP))
        # every column ends on the same line: the last panel of a shorter column stretches
        for column in self.columns:
            last = column[-1]
            last.height = tallest - last.y
        return even(tallest + px(self.PAD))

    def render(self, palette: Palette) -> Image.Image:
        height = self.layout()
        image = Image.new("RGBA", (self.width, height), palette.page)
        self.draw_header(image, palette)
        draw = ImageDraw.Draw(image)
        colours = {
            "subtitle": palette.text_muted,
            "label": palette.text,
            "label-accent": palette.accent_text,
            "note": palette.text_secondary,
        }
        for column in self.columns:
            for panel in column:
                draw.rounded_rectangle(
                    (panel.x, panel.y, panel.x + panel.width, panel.y + panel.height),
                    radius=px(12),
                    fill=palette.surface,
                    outline=palette.accent if panel.emphasis else palette.border,
                    width=SCALE * (2 if panel.emphasis else 1),
                )
                ox, oy = panel.x + self.pad(), panel.y + self.pad()
                for dx, dy, f, text, role, bullet in self.flow(panel, panel.width):
                    fill = (palette.accent_text if panel.emphasis else palette.text) if role == "title" else colours[role]
                    if bullet:
                        dot = oy + dy + line_height(f) // 2 - px(2)
                        draw.ellipse([ox + px(2), dot, ox + px(6), dot + px(4)], fill=palette.accent)
                    draw.text((ox + dx, oy + dy), text, font=f, fill=fill)
        lookup = {p.title: p for column in self.columns for p in column}
        for source, target, label in self.arrows:
            a, b = lookup[source], lookup[target]
            top = max(a.y, b.y) + px(16)
            bottom = min(a.y + a.height, b.y + b.height) - px(16)
            if top > bottom:
                raise SystemExit(f"ERROR: the arrow {source} -> {target} has no shared height to run along")
            y = (top + bottom) // 2
            x1, x2 = a.x + a.width, b.x
            draw.line([(x1 + px(4), y), (x2 - px(7), y)], fill=palette.border_strong, width=SCALE)
            draw.polygon([(x2 - px(7), y - px(4)), (x2 - px(1), y), (x2 - px(7), y + px(4))], fill=palette.border_strong)
            if label:
                width = int(draw.textlength(label, font=self.f_arrow))
                draw.text(((x1 + x2) // 2 - width // 2, y - line_height(self.f_arrow) - px(2)), label, font=self.f_arrow, fill=palette.text_muted)
        return finish(image)


# ---------- the tree ----------


@dataclass
class Row:
    name: str
    note: str
    depth: int
    directory: bool = False
    band: bool = False


class Tree(Figure):
    INDENT = 16
    STUB = 8
    NAME_GAP = 20
    ROW_GAP = 6
    CARD_PAD = 18

    def __init__(self, title: str, subtitle: str, rows: list[Row]):
        super().__init__(title, subtitle)
        self.rows = rows
        self.f_name = font("mono", 9)
        self.f_note = font("regular", 9)

    def name_column(self) -> int:
        return max(px(self.INDENT) * r.depth + px(self.STUB) + px(4) + int(self._probe.textlength(r.name, font=self.f_name)) for r in self.rows) + px(self.NAME_GAP)

    def row_height(self) -> int:
        return max(line_height(self.f_name), line_height(self.f_note)) + px(self.ROW_GAP)

    def last_child(self, index: int) -> bool:
        depth = self.rows[index].depth
        for r in self.rows[index + 1 :]:
            if r.depth < depth:
                return True
            if r.depth == depth:
                return False
        return True

    def continues(self, index: int, depth: int) -> bool:
        """Does an ancestor at `depth` still have a child below row `index`?"""
        for r in self.rows[index + 1 :]:
            if r.depth < depth:
                return False
            if r.depth == depth:
                return True
        return False

    def render(self, palette: Palette) -> Image.Image:
        top = self.header_height()
        rh = self.row_height()
        card = (px(self.PAD), top, self.width - px(self.PAD), top + 2 * px(self.CARD_PAD) + rh * len(self.rows) - px(self.ROW_GAP))
        height = even(card[3] + px(self.PAD))
        image = Image.new("RGBA", (self.width, height), palette.page)
        self.draw_header(image, palette)
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle(card, radius=px(12), fill=palette.surface, outline=palette.border, width=SCALE)
        left = card[0] + px(self.CARD_PAD)
        y0 = card[1] + px(self.CARD_PAD)
        notes_x = left + self.name_column()
        # bands first, contiguous rows share one
        i = 0
        while i < len(self.rows):
            if self.rows[i].band:
                j = i
                while j + 1 < len(self.rows) and self.rows[j + 1].band:
                    j += 1
                draw.rounded_rectangle((card[0] + px(6), y0 + i * rh - px(3), card[2] - px(6), y0 + (j + 1) * rh - px(self.ROW_GAP) + px(3)), radius=px(6), fill=palette.band)
                i = j + 1
            else:
                i += 1
        mid = line_height(self.f_name) // 2
        for index, row in enumerate(self.rows):
            y = y0 + index * rh
            x = left + px(self.INDENT) * row.depth
            if row.depth > 0:
                stem = x - px(self.INDENT) + px(4)
                parent_y = y - rh + line_height(self.f_name) - px(2)
                end = y + mid
                draw.line([(stem, parent_y if index > 0 else y), (stem, end)], fill=palette.border_strong, width=SCALE)
                draw.line([(stem, end), (x + px(self.STUB) - px(2), end)], fill=palette.border_strong, width=SCALE)
                for d in range(1, row.depth):
                    if self.continues(index, d):
                        sx = left + px(self.INDENT) * (d - 1) + px(4)
                        draw.line([(sx, y - px(self.ROW_GAP)), (sx, y + rh)], fill=palette.border_strong, width=SCALE)
                if not self.last_child(index):
                    draw.line([(stem, end), (stem, y + rh)], fill=palette.border_strong, width=SCALE)
            name_x = x + (px(self.STUB) + px(4) if row.depth > 0 else 0)
            draw.text((name_x, y), row.name, font=self.f_name, fill=palette.accent_text if row.directory else palette.text)
            draw.text((notes_x, y), row.note, font=self.f_note, fill=palette.text_secondary)
        return finish(image)


# ---------- the hero ----------


def hero(palette: Palette, tagline: str) -> Image.Image:
    width, height = px(FIGURE_WIDTH), px(232)
    inset = px(2)
    card = (inset, inset, width - inset - 1, height - inset - 1)
    gradient = Image.new("RGBA", (width, height))
    g = ImageDraw.Draw(gradient)
    top, bottom = parse_hex(palette.surface), parse_hex(palette.page)
    for row in range(height):
        t = row / max(1, height - 1)
        g.line([(0, row), (width, row)], fill=tuple(int(top[c] + (bottom[c] - top[c]) * t) for c in range(3)))
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle(card, radius=px(22), fill=255)
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(card, radius=px(22), outline=palette.border_strong, width=SCALE)

    source = Image.open(MARK).convert("RGBA")
    mark_size = px(124)
    art = source.getchannel("A").getbbox()
    scale = mark_size / source.height
    art_left, art_top = round(art[0] * scale), round(art[1] * scale)
    art_w, art_h = round((art[2] - art[0]) * scale), round((art[3] - art[1]) * scale)
    mark = source.resize((mark_size, mark_size), Image.LANCZOS)
    f_word, f_tag = font("bold", 60), font("regular", 14)
    word = "Hushd"
    word_box = draw.textbbox((0, 0), word, font=f_word)
    tag_box = draw.textbbox((0, 0), tagline, font=f_tag)
    gap, tag_gap, rule_gap, rule_h, rule_w = px(22), px(18), px(20), px(3), px(46)
    block_h = art_h + tag_gap + (tag_box[3] - tag_box[1]) + rule_gap + rule_h
    art_y = inset + (height - inset * 2 - block_h) // 2
    block_w = art_w + gap + (word_box[2] - word_box[0])
    art_x = (width - block_w) // 2
    image.paste(mark, (art_x - art_left, art_y - art_top), mark)
    draw.text((art_x + art_w + gap - word_box[0], art_y + art_h // 2 - (word_box[1] + word_box[3]) // 2), word, font=f_word, fill=palette.text)
    tag_y = art_y + art_h + tag_gap
    draw.text(((width - (tag_box[2] - tag_box[0])) // 2 - tag_box[0], tag_y - tag_box[1]), tagline, font=f_tag, fill=palette.text_muted)
    rule_y = tag_y + (tag_box[3] - tag_box[1]) + rule_gap
    draw.rounded_rectangle(((width - rule_w) // 2, rule_y, (width + rule_w) // 2, rule_y + rule_h), radius=px(2), fill=palette.accent)
    return finish(image)


# ---------- content ----------

TAGLINE = "Private OTC on NEAR, run by agents."


def pipeline() -> Columns:
    ask = Panel(
        "Ask without showing your hand",
        [
            Item("Words or a form", "Words go end-to-end encrypted to a NEAR AI model whose TDX and GPU quote the browser checked"),
            Item("packageRequest()", "Kind, sell, buy and the least you accept, plus a per-deal owner key", mono=True),
            Item("Sealed to the enclave key", "Only sha256 of the box goes on chain: desk.open_rfq, sent by the relayer"),
        ],
        subtitle="The trader's browser or agent",
    )
    makers = Panel(
        "Makers quote blind",
        [
            Item("They see pair, side and size", "Never the limit. Prices from Hyperliquid mids, a spread by style"),
            Item("Quote sealed and signed", "Its quote key signs the terms hash, bond and expiry; the desk checks it with ed25519_verify"),
        ],
        subtitle="Three reference makers, each bonded on the desk",
    )
    enclave = Panel(
        "Matched in a TEE",
        [
            Item("Opens the request and every quote", "Keys made inside the enclave from PROTECTED_MATCHER_KEY"),
            Item("Best quote inside the limit"),
            Item("Signs the match", "The desk accepts it only from OutLayer's callback or under the enclave key", accent=True),
        ],
        subtitle="matcher/ on OutLayer",
        emphasis=True,
    )
    settle = Panel(
        "Settled in one call",
        [
            Item("Swap note openings in a sealed room", "Each side checks the note made for it"),
            Item("Both legs bound to the deal", "extHash covers the deal id and all four outputs"),
            Item("pool.settle_swap", "Both legs or neither, about 125 Tgas", mono=True),
        ],
        subtitle="Private notes in the pool",
    )
    receipt = Panel(
        "Receipt and hedge",
        [
            Item("settled, recovered, failed, unresolved", "With evidence on the desk record"),
            Item("Hedge signed by Chain Signatures", "Path hushd/hedge/<deal>; a missed hedge pays the bond to the trader as a note"),
        ],
    )
    never = Panel(
        "What it will not do",
        [
            Item("Put an amount or a party on chain", "The chain sees a deal hash and an outcome"),
            Item("Let the relayer change a proof", "It can refuse to send, never redirect"),
        ],
    )
    return Columns(
        "How one deal works",
        "A sealed request, a match inside an enclave, then both legs settle privately in one pool call.",
        [[ask, makers], [enclave], [settle, receipt, never]],
        [("Ask without showing your hand", "Matched in a TEE", "sealed request"), ("Makers quote blind", "Matched in a TEE", "sealed quotes"), ("Matched in a TEE", "Settled in one call", "signed match")],
    )


def repository() -> Columns:
    contracts = Panel(
        "Contracts on NEAR",
        [
            Item("contracts/pool", "Notes, nullifiers, depth-20 Poseidon tree; a Groth16 check on alt_bn128 in about 36 Tgas", mono=True),
            Item("contracts/desk", "Makers and NEP-141 bonds, RFQ commitments, matches, receipts, slashing", mono=True),
            Item("desk/src/hedge.rs", "Hyperliquid msgpack and EIP-712 digest, pinned against reference vectors", mono=True, accent=True),
            Item("contracts/board, token", "Sealed note posts; test tokens with a faucet", mono=True),
        ],
        subtitle="Rust, near-sdk 5, 153 unit tests and 6 sandbox tests",
    )
    zk = Panel(
        "Proofs and the enclave",
        [
            Item("circuits/joinsplit", "Two notes in, two out; binds recipient, relayer, fee, refund note", mono=True),
            Item("receipt, funds, volume", "One reader and an expiry in the context input", mono=True),
            Item("matcher/", "WASI P2 on OutLayer; the same terms bytes as the TS protocol package", mono=True, accent=True),
        ],
        subtitle="circom 2, development keys",
        emphasis=True,
    )
    agents = Panel(
        "Agents and services",
        [
            Item("packages/sdk", "Private wallet, desk flows, proofs, private x402", mono=True),
            Item("packages/mcp", "22 tools, limits per payment and per day", mono=True, accent=True),
            Item("services/", "Relayer (dry-runs every proof), API with NEAR AI intake, indexer, makers, keeper", mono=True),
            Item("app/", "The desk, deals, proofs and /verify; hosted MCP at /mcp", mono=True),
        ],
        subtitle="TypeScript",
    )
    return Columns("What is in the repository", "Three parts: what runs on chain, what proves and matches, and what agents and people use.", [[contracts], [zk], [agents]], [])


def tree() -> Tree:
    rows = [
        Row("hushd/", "a private OTC desk on NEAR testnet", 0, True),
        Row("contracts/", "Rust, cargo-near", 1, True, True),
        Row("pool/", "notes, Groth16 on alt_bn128, settle_swap, verify_disclosure", 2, True, True),
        Row("desk/", "makers, bonds, RFQs, enclave matches, receipts, hedges", 2, True, True),
        Row("board/", "sealed note posts, poster never recorded", 2, True, True),
        Row("token/", "test NEP-141 with a faucet", 2, True, True),
        Row("sandbox-tests/", "end to end on a local nearcore", 2, True, True),
        Row("circuits/", "joinsplit, receipt, funds, volume (circom)", 1, True),
        Row("matcher/", "the enclave: opens sealed requests and quotes, signs the match", 1, True),
        Row("packages/", "", 1, True),
        Row("sdk/", "@hushd/sdk: wallet, desk, proofs, x402, intake", 2, True),
        Row("protocol/", "package terms and the bytes both sides sign", 2, True),
        Row("mcp/", "@hushd/mcp: read and wallet tools inside limits", 2, True),
        Row("services/", "relayer, API, indexer, matcher client, makers, keeper", 1, True),
        Row("app/", "Next.js: site, /app, /verify, /mcp", 1, True),
        Row("deploy/", "Dockerfile, compose, Caddy", 1, True),
        Row("skills/hushd/SKILL.md", "the agent skill", 1),
        Row("AGENTS.md", "how to work in this repo", 1),
    ]
    return Tree("The files", "Where each part lives. The banded subtree holds the money.", rows)


# ---------- main ----------


def png(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def main(argv: list[str]) -> int:
    check = "--check" in argv
    if not MARK.is_file():
        print(f"ERROR: {MARK} is missing.")
        return 2
    for kind, path in FONTS.items():
        if not Path(path).is_file():
            print(f"ERROR: the {kind} font is missing at {path}.")
            return 2
    problems = audit(DARK) + audit(LIGHT)
    if problems:
        print("Contrast failures; nothing written.")
        return 1
    images = {
        "hero-dark.png": hero(DARK, TAGLINE),
        "hero-light.png": hero(LIGHT, TAGLINE),
        "pipeline.png": pipeline().render(LIGHT),
        "repository.png": repository().render(LIGHT),
        "tree.png": tree().render(LIGHT),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    changed = 0
    for name, image in images.items():
        data = png(image)
        path = OUT / name
        same = path.is_file() and hashlib.sha256(path.read_bytes()).digest() == hashlib.sha256(data).digest()
        if not same:
            changed += 1
            print(f"{'would write' if check else 'wrote'} {path.relative_to(ROOT)} ({image.width}x{image.height})")
            if not check:
                path.write_bytes(data)
    print(f"{changed} of {len(images)} images {'would change' if check else 'changed'}.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
