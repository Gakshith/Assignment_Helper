"""Draw recovered outlines so a human can look at them.

An extraction strand that has never looked at its own output is not done. Numbers say
coverage was 100%; only the picture says the `e` still has a counter and the `g`
hangs below the line instead of floating above it.

This renders ONLY from the em-unit contours — never from the source image — so what
you are looking at is exactly what was written to the profile. If the profile is
wrong, this picture is wrong in the same way, which is the point.

Not on the serve path. I17: CV imports live inside function bodies.
"""

from __future__ import annotations

from pathlib import Path

from assignment_helper.glyphs.layout import UNITS_PER_EM

INK = (20, 25, 35)
PAPER = (255, 255, 255)
BASELINE = (222, 226, 232)
LABEL = (200, 60, 60)


def render_outline_sheet(
    outlines,
    destination: Path,
    *,
    columns: int = 10,
    tile_px: int = 130,
) -> Path:
    """Draw every outline into a contact sheet and save it.

    Holes are painted in paper colour after their outer contour, which is why a
    counter that survived extraction shows up as a white hole and a counter that was
    lost shows up as a filled blob. That difference is the whole reason to look.
    """
    from PIL import Image, ImageDraw

    if not outlines:
        raise ValueError("render_outline_sheet was given no outlines to draw")

    rows = (len(outlines) + columns - 1) // columns
    canvas = Image.new("RGB", (columns * tile_px, rows * tile_px), PAPER)
    draw = ImageDraw.Draw(canvas)

    # One em is drawn at ~55% of a tile, leaving room for ascenders and descenders.
    scale = (tile_px * 0.55) / UNITS_PER_EM

    for i, glyph in enumerate(outlines):
        tile_x = (i % columns) * tile_px
        tile_y = (i // columns) * tile_px
        origin_x = tile_x + tile_px * 0.10
        origin_y = tile_y + tile_px * 0.68

        draw.line([(tile_x, origin_y), (tile_x + tile_px, origin_y)], fill=BASELINE)

        # Outer contours first, then holes on top: PIL has no even-odd fill, so the
        # counters are punched out by overdrawing them in paper colour.
        for want_outer in (True, False):
            for is_outer, points in glyph.contours:
                if is_outer is not want_outer or len(points) < 3:
                    continue
                polygon = [(origin_x + x * scale, origin_y - y * scale) for x, y in points]
                draw.polygon(polygon, fill=INK if is_outer else PAPER)

        draw.text((tile_x + 3, tile_y + 3), glyph.ch, fill=LABEL)

    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(destination)
    return destination
