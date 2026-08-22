#!/usr/bin/env python3

import json
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError as error:
    raise SystemExit("Pillow is required: python3 -m pip install Pillow") from error


WIDTH = 1280
HEIGHT = 720
SCALE = 2
CANVAS = (WIDTH * SCALE, HEIGHT * SCALE)

COLORS = {
    "desktop_top": "#111827",
    "desktop_bottom": "#070b11",
    "terminal": "#111418",
    "toolbar": "#2b2d31",
    "toolbar_border": "#17191c",
    "foreground": "#e6edf3",
    "muted": "#8b949e",
    "blue": "#58a6ff",
    "red": "#ff6b7a",
    "green": "#5ee38d",
    "yellow": "#f6c85f",
}


def first_existing(paths):
    for path in paths:
        if path and Path(path).exists():
            return path
    return None


REGULAR_FONT = first_existing([
    os.environ.get("TOOLFENCE_DEMO_FONT"),
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Supplemental/Andale Mono.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
])
BOLD_FONT = first_existing([
    os.environ.get("TOOLFENCE_DEMO_BOLD_FONT"),
    "/System/Library/Fonts/SFNSMonoBold.ttf",
    "/System/Library/Fonts/Supplemental/Andale Mono Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf",
    REGULAR_FONT,
])

if not REGULAR_FONT:
    raise SystemExit(
        "No supported monospace font found. Set TOOLFENCE_DEMO_FONT to a TTF or OTF file."
    )


def font(size, bold=False):
    return ImageFont.truetype(BOLD_FONT if bold else REGULAR_FONT, size * SCALE)


def scaled_box(box):
    return tuple(round(value * SCALE) for value in box)


def draw_text(draw, xy, value, color="foreground", size=20, bold=False):
    draw.text(
        (xy[0] * SCALE, xy[1] * SCALE),
        value,
        font=font(size, bold),
        fill=COLORS.get(color, color),
    )


def terminal_cursor(draw, x, y, visible=True):
    if visible:
        draw.rounded_rectangle(
            scaled_box((x, y, x + 10, y + 22)),
            radius=2 * SCALE,
            fill=COLORS["foreground"],
        )


def background():
    image = Image.new("RGB", CANVAS, COLORS["desktop_top"])
    draw = ImageDraw.Draw(image)
    top = (17, 24, 39)
    bottom = (7, 11, 17)
    for y in range(CANVAS[1]):
        ratio = y / max(1, CANVAS[1] - 1)
        color = tuple(round(top[index] * (1 - ratio) + bottom[index] * ratio) for index in range(3))
        draw.line((0, y, CANVAS[0], y), fill=color)
    return image


def terminal_window(image):
    shadow = Image.new("RGBA", CANVAS, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        scaled_box((50, 38, 1230, 690)),
        radius=18 * SCALE,
        fill=(0, 0, 0, 190),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(18 * SCALE))
    image.paste(shadow, (0, 0), shadow)

    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        scaled_box((64, 44, 1216, 676)),
        radius=14 * SCALE,
        fill=COLORS["terminal"],
        outline="#3a3d43",
        width=1 * SCALE,
    )
    draw.rounded_rectangle(
        scaled_box((64, 44, 1216, 98)),
        radius=14 * SCALE,
        fill=COLORS["toolbar"],
    )
    draw.rectangle(scaled_box((64, 82, 1216, 98)), fill=COLORS["toolbar"])
    draw.line(scaled_box((64, 98, 1216, 98)), fill=COLORS["toolbar_border"], width=1 * SCALE)

    for x, color, outline in [
        (91, "#ff5f57", "#e0443e"),
        (115, "#febc2e", "#dea123"),
        (139, "#28c840", "#1aab29"),
    ]:
        draw.ellipse(
            scaled_box((x - 7, 64 - 7, x + 7, 64 + 7)),
            fill=color,
            outline=outline,
            width=1 * SCALE,
        )

    title = "toolfence-demo — zsh — 120x34"
    title_font = font(14)
    title_box = draw.textbbox((0, 0), title, font=title_font)
    title_width = title_box[2] - title_box[0]
    draw.text(
        ((CANVAS[0] - title_width) / 2, 57 * SCALE),
        title,
        font=title_font,
        fill="#b7bac1",
    )
    return draw


def render_frame(recording, stage, output):
    image = background()
    draw = terminal_window(image)
    x = 102
    y = 124
    line = 42

    draw_text(draw, (x, y), "# Same MCP call. Different outcome.", "muted", 18)
    y += line + 8

    if stage <= 3:
        draw_text(draw, (x, y), "WITHOUT TOOLFENCE", "red", 20, True)
        y += line + 4
        if stage >= 1:
            draw_text(draw, (x, y), "$", "blue", 20, True)
            draw_text(draw, (x + 28, y), "mcp call read_text_file .env", size=20)
            y += line
            draw_text(
                draw,
                (x, y),
                f"Connecting directly to filesystem MCP {recording['filesystemVersion']}",
                "muted",
                17,
            )
            y += line + 10
        if stage >= 2:
            draw_text(draw, (x, y), recording["attack"]["result"], "foreground", 21)
            y += line + 14
            draw_text(draw, (x, y), "[LEAKED] Upstream returned the .env contents", "red", 20, True)
            y += line + 24
            draw_text(draw, (x, y), "The tool call had no policy enforcement boundary.", "muted", 17)
        terminal_cursor(draw, x, 628, stage in (0, 3))
    else:
        draw_text(draw, (x, y), "WITH TOOLFENCE", "green", 20, True)
        y += line + 4
        draw_text(draw, (x, y), "$", "blue", 20, True)
        draw_text(
            draw,
            (x + 28, y),
            "toolfence wrap --policy ./toolfence.yaml --server filesystem -- ...",
            size=18,
        )
        y += line
        draw_text(draw, (x, y), "Policy loaded: protect-secrets", "green", 17)
        y += line + 10

        if stage >= 5:
            draw_text(draw, (x, y), "$", "blue", 20, True)
            draw_text(draw, (x + 28, y), "mcp call read_text_file .env", size=20)
            y += line + 12
        if stage >= 6:
            draw_text(draw, (x, y), "DENY", "red", 20, True)
            draw_text(draw, (x + 76, y), "ToolFence denied this tool call", "foreground", 20)
            y += line
            draw_text(
                draw,
                (x, y),
                "Rule: protect-secrets    Operation: fs.read    Upstream: not executed",
                "muted",
                17,
            )
            y += line + 10
        if stage >= 7:
            draw_text(draw, (x, y), "AUDIT", "yellow", 18, True)
            draw_text(draw, (x + 82, y), "fs.read  .env  deny  rule=protect-secrets", size=18)
            y += line
            draw_text(draw, (x, y), "Audit stores no raw arguments or results.", "muted", 17)
            y += line + 16
        if stage >= 8:
            draw_text(draw, (x, y), "$", "blue", 20, True)
            draw_text(draw, (x + 28, y), "toolfence policy init", "green", 20, True)
            terminal_cursor(draw, x + 310, y + 3, True)
        else:
            terminal_cursor(draw, x, 628, stage % 2 == 0)

    image = image.resize((WIDTH, HEIGHT), Image.Resampling.LANCZOS)
    image.save(output, "PNG", optimize=True)


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: render-env-frames.py RECORDING_JSON OUTPUT_DIRECTORY")
    recording = json.loads(Path(sys.argv[1]).read_text(encoding="utf8"))
    output_directory = Path(sys.argv[2])
    stages = [0, 1, 2, 3, 4, 5, 6, 7, 8, 8]
    for index, stage in enumerate(stages):
        render_frame(recording, stage, output_directory / f"frame-{index:02d}.png")


if __name__ == "__main__":
    main()
