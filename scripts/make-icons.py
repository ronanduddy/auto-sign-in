#!/usr/bin/env python3
"""Draw the extension icons (a sign-in arrow on Slack aubergine) as PNGs.

Uses only the standard library. Run it from anywhere; it writes icons/icon{16,32,48,128}.png.
"""
import struct
import zlib
from pathlib import Path

BACKGROUND = (74, 21, 75)  # Slack aubergine
FOREGROUND = (255, 255, 255)
SIZES = (16, 32, 48, 128)
SUPERSAMPLE = 4  # samples per pixel along each axis, for smooth edges
CORNER = 0.22  # corner radius as a fraction of the icon size


def in_rounded_square(x, y):
    cx = min(max(x, CORNER), 1 - CORNER)
    cy = min(max(y, CORNER), 1 - CORNER)
    return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER**2


def in_glyph(x, y):
    # A "]" door on the right...
    if 0.62 <= x <= 0.72 and 0.24 <= y <= 0.76:
        return True
    if 0.46 <= x <= 0.72 and (0.24 <= y <= 0.33 or 0.67 <= y <= 0.76):
        return True
    # ...and an arrow going into it.
    if 0.20 <= x <= 0.44 and 0.455 <= y <= 0.545:
        return True
    if 0.40 <= x <= 0.58 and abs(y - 0.5) <= 0.16 * (0.58 - x) / 0.18:
        return True
    return False


def render(size):
    rows = []
    samples = SUPERSAMPLE * SUPERSAMPLE
    for py in range(size):
        row = bytearray([0])  # PNG filter type: none
        for px in range(size):
            covered = glyph = 0
            for sy in range(SUPERSAMPLE):
                for sx in range(SUPERSAMPLE):
                    x = (px + (sx + 0.5) / SUPERSAMPLE) / size
                    y = (py + (sy + 0.5) / SUPERSAMPLE) / size
                    if in_rounded_square(x, y):
                        covered += 1
                        glyph += in_glyph(x, y)
            mix = glyph / covered if covered else 0
            rgb = [round(b + (f - b) * mix) for b, f in zip(BACKGROUND, FOREGROUND)]
            row += bytes(rgb + [round(255 * covered / samples)])
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


def main():
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size in SIZES:
        (out / f"icon{size}.png").write_bytes(render(size))
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
