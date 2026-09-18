"""Render a FILLED-IN tracing sheet from the OFL reference font.

Invariant I9 and the repo is public: no test may use the user's handwriting. So the
test sheet is generated — the reference hand is drawn into the cells exactly where a
person would have written, and the sheet is then abused in the ways a photo is
(perspective, shadow, blur).

This is the strongest test available to this strand, and it is stronger than a fixture
photo would be: because the glyphs are drawn from a font at a known size on a known
baseline, the TRUE advance, ascent and descent of every cell are known exactly, so the
round-trip can assert on real numbers instead of on "it did not crash".

The fonts under spikes/m0/fonts/ are read as DATA — this module never imports the
`spikes` package, which the second import-linter contract forbids.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

from assignment_helper.glyphs import layout, sheet
from assignment_helper.glyphs.charset import CHARSET

REPO_ROOT = Path(__file__).resolve().parents[2]
FONT_DIR = REPO_ROOT / "spikes" / "m0" / "fonts"

#: Caveat has the widest glyph coverage of the three reference hands and real counters
#: in `o`, `a`, `e`, so it is the one the hole-preservation test needs.
REFERENCE_FONT = FONT_DIR / "Caveat-Regular.ttf"

INK = (26, 32, 44)


@dataclass(frozen=True)
class TrueMetrics:
    """The exact metrics of a drawn glyph, in em units. Ground truth for the round-trip."""

    ch: str
    advance: float
    ascent: float
    descent: float
    has_ink: bool


def _font_for_cell(cell: layout.CellBox, font_path: Path):
    from PIL import ImageFont

    return ImageFont.truetype(str(font_path), size=int(round(cell.em_px)))


def render_filled_page(
    page: int,
    charset: list[str] | None = None,
    font_path: Path | None = None,
    *,
    skip: set[str] | None = None,
    jitter: float = 0.0,
):
    """A tracing-sheet page with the reference hand written into every cell.

    `jitter` displaces each glyph by up to that many em, deterministically per cell,
    to mimic a person not centring perfectly. `skip` leaves cells blank, which is how
    the viability tests produce a sheet that is legitimately incomplete.
    """
    from PIL import ImageDraw

    from assignment_helper.rng import rand_range

    chars = charset if charset is not None else CHARSET
    font_path = font_path or REFERENCE_FONT
    skip = skip or set()

    image = sheet.build_page(page, chars)
    draw = ImageDraw.Draw(image)

    truth: dict[str, TrueMetrics] = {}
    for cell in layout.cells_for_page(chars, page):
        if cell.ch in skip:
            continue
        font = _font_for_cell(cell, font_path)
        scale = layout.UNITS_PER_EM / cell.em_px

        dx = dy = 0.0
        if jitter:
            seed = page * 7919 + cell.index
            dx = rand_range(seed, "glyph-x", cell.index, -jitter, jitter) * cell.em_px
            dy = rand_range(seed, "glyph-y", cell.index, -jitter, jitter) * cell.em_px

        # anchor="ls" puts the drawing origin at the BASELINE, left side - the same
        # origin the extractor measures ascent and descent from.
        x = cell.left + cell.width * 0.30 + dx
        y = cell.baseline_y + dy
        draw.text((x, y), cell.ch, font=font, fill=INK, anchor="ls")

        box = font.getbbox(cell.ch, anchor="ls")
        truth[cell.ch] = TrueMetrics(
            ch=cell.ch,
            advance=font.getlength(cell.ch) * scale,
            ascent=max(0.0, -box[1]) * scale,
            descent=max(0.0, box[3]) * scale,
            has_ink=(box[2] - box[0]) > 0 and (box[3] - box[1]) > 0,
        )

    return image, truth


def to_bgr(image):
    """Pillow RGB -> the BGR ndarray the pipeline works in."""
    import numpy as np

    return np.asarray(image)[:, :, ::-1].copy()


def photograph(
    image,
    *,
    angle_deg: float = 0.0,
    shadow: float = 0.0,
    blur: float = 0.0,
    scale: float = 0.55,
):
    """Abuse a clean sheet into something that looks like a phone photo.

    `angle_deg` tilts the sheet about its vertical axis, which is the off-axis case in
    acceptance row 24. `shadow` adds a linear illumination gradient, `blur` softens,
    and `scale` shrinks — a real photo is not 300 dpi.
    """
    import cv2
    import numpy as np

    bgr = to_bgr(image)
    h, w = bgr.shape[:2]

    if angle_deg:
        # Rotate the page about its vertical centre line in 3D and re-project. The
        # shrink factor keeps the far edge inside the frame at 50 degrees.
        theta = math.radians(angle_deg)
        shrink = math.cos(theta)
        offset = w * 0.5 * (1 - shrink) * 0.5
        src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
        dst = np.float32([
            [offset, h * (1 - shrink) * 0.25],
            [w - offset * 0.2, 0],
            [w - offset * 0.2, h],
            [offset, h - h * (1 - shrink) * 0.25],
        ])
        matrix = cv2.getPerspectiveTransform(src, dst)
        bgr = cv2.warpPerspective(
            bgr, matrix, (w, h), flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255),
        )

    if shadow:
        gradient = np.linspace(1.0, 1.0 - shadow, w, dtype=np.float32)[None, :, None]
        vertical = np.linspace(1.0, 1.0 - shadow * 0.4, h, dtype=np.float32)[:, None, None]
        bgr = np.clip(bgr.astype(np.float32) * gradient * vertical, 0, 255).astype(np.uint8)

    if scale != 1.0:
        bgr = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)

    if blur:
        k = int(blur) * 2 + 1
        bgr = cv2.GaussianBlur(bgr, (k, k), 0)

    return bgr


def encode_png(bgr) -> bytes:
    """Encode to PNG bytes, the way an upload arrives."""
    import cv2

    ok, buffer = cv2.imencode(".png", bgr)
    if not ok:
        raise RuntimeError("cv2.imencode failed to encode the synthetic sheet")
    return buffer.tobytes()


def blank_marker_page(page: int, keep: int = 3, charset: list[str] | None = None):
    """A filled page with all but `keep` of its corner markers painted out.

    Acceptance row 4's input. The markers are covered in white rather than the page
    being cropped, so the failure is unambiguously "a marker is missing" and not "the
    image is a different size".
    """
    from PIL import ImageDraw

    image, _truth = render_filled_page(page, charset)
    draw = ImageDraw.Draw(image)
    for rect in layout.marker_rects()[keep:]:
        x0, y0, x1, y1 = rect
        draw.rectangle([x0 - 6, y0 - 6, x1 + 6, y1 + 6], fill=(255, 255, 255))
    return image
