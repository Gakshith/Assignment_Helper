"""Ink mask -> closed contours in em units, plus real metrics.

This is the heart of M2 and it is deliberately small. Under outline-first (plan §C.1)
there is no skeleton, no graph, no junction traversal, no spur pruning, no stroke order
and no direction. The #1 risk in the original plan was recovering stroke ORDER from a
photograph, and the architecture was changed specifically so that risk does not exist:
keep the outline and there is no stroke to run backwards.

If you are reading this because you want to add `skeletonize`, that is the risk coming
back. Don't.

What outlines buy in exchange is metrics that are actually computable. Ascent and
descent are measured from the printed baseline, which the sheet put at a known place
in every cell, so they are real distances and not guesses from a bounding box.

Coordinates out of this module match `GlyphOutlineProvider`: a unit em box, y-up,
origin at the baseline origin, scaled to `layout.UNITS_PER_EM` per em.

I17: every CV import is inside a function body.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from assignment_helper.glyphs import layout
from assignment_helper.glyphs.errors import CellFailure

#: Douglas-Peucker tolerance, as a fraction of one em. Small: this smooths out the
#: single-pixel staircase from the threshold without rounding off the corner of a `k`.
SIMPLIFY_EM = 0.004

#: A contour with fewer points than this after simplification is not a shape.
MIN_CONTOUR_POINTS = 3
#: An inner contour smaller than this fraction of an em squared is a pinhole in the
#: ink, not a counter. The counter of an `e` is ~1.5% of an em squared; noise is ~0.01%.
MIN_HOLE_AREA_EM2 = 0.0015


@dataclass
class GlyphOutline:
    """One extracted sample of one character: its contours and its real metrics.

    `contours` is a list of `(is_outer, points)`. Points are (x, y) in em units,
    y-up, baseline at y=0, pen origin at x=0. Closed implicitly - the last point
    joins the first, as Path2D does on `closePath`.
    """

    ch: str
    repeat: int
    page: int
    contours: list[tuple[bool, list[tuple[float, float]]]] = field(default_factory=list)
    advance: float = 0.0
    ascent: float = 0.0
    descent: float = 0.0
    ink_pixels: int = 0

    @property
    def hole_count(self) -> int:
        return sum(1 for is_outer, _ in self.contours if not is_outer)


def _polygon_area(points) -> float:
    """Twice the signed shoelace area, halved. Sign is orientation; callers take abs."""
    area = 0.0
    n = len(points)
    for i in range(n):
        x0, y0 = points[i]
        x1, y1 = points[(i + 1) % n]
        area += x0 * y1 - x1 * y0
    return area / 2.0


def extract_outline(cell_ink, drop_blue_used: bool = True) -> GlyphOutline | CellFailure:
    """Extract one glyph's outline from a segmented cell.

    Returns a `GlyphOutline`, or a `CellFailure` when the mask holds no usable closed
    contour. It does not raise: a cell that fails is reported, not fatal.

    `RETR_CCOMP` gives a two-level hierarchy — outer boundaries at the top level and
    holes as their children — which is exactly what keeps the counters in `o`, `a`,
    `e`, `b`, `d`, `g`, `p`, `q` and `B` from being filled in. `RETR_EXTERNAL` would
    be simpler and would silently turn every `o` into a blob.
    """
    import cv2

    cell = cell_ink.cell
    mask = cell_ink.mask
    ox, oy = cell_ink.crop_origin

    contours, hierarchy = cv2.findContours(mask, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if not contours or hierarchy is None:
        return CellFailure(cell.ch, cell.repeat, cell.page, "no-contour",
                           "the ink produced no closed contour")

    px_per_em = cell.em_px
    scale = layout.UNITS_PER_EM / px_per_em
    epsilon = SIMPLIFY_EM * px_per_em

    # Ink extent in canonical page pixels, used for the metrics and the x origin.
    import numpy as np

    ys, xs = np.nonzero(mask)
    ink_left = float(xs.min()) + ox
    ink_right = float(xs.max()) + ox
    ink_top = float(ys.min()) + oy
    ink_bottom = float(ys.max()) + oy

    side_bearing_px = layout.SIDE_BEARING_EM * px_per_em
    origin_x = ink_left - side_bearing_px
    baseline_y = cell.baseline_y

    def to_em(pt) -> tuple[float, float]:
        x, y = float(pt[0]) + ox, float(pt[1]) + oy
        return ((x - origin_x) * scale, (baseline_y - y) * scale)

    hierarchy = hierarchy.reshape(-1, 4)
    out: list[tuple[bool, list[tuple[float, float]]]] = []
    min_hole_area = MIN_HOLE_AREA_EM2 * (layout.UNITS_PER_EM ** 2)

    for i, contour in enumerate(contours):
        simplified = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
        if len(simplified) < MIN_CONTOUR_POINTS:
            continue
        points = [to_em(p) for p in simplified]
        # bool(), not the bare comparison: numpy returns np.bool_, which json.dumps
        # refuses. Without this cast every profile write dies at the last step, and it
        # dies on the FIRST glyph with a hole, so a charset without one would hide it.
        is_outer = bool(hierarchy[i][3] < 0)
        if not is_outer and abs(_polygon_area(points)) < min_hole_area:
            continue
        out.append((is_outer, points))

    if not any(is_outer for is_outer, _ in out):
        return CellFailure(cell.ch, cell.repeat, cell.page, "no-contour",
                           "no outer contour survived simplification")

    return GlyphOutline(
        ch=cell.ch,
        repeat=cell.repeat,
        page=cell.page,
        contours=out,
        # Advance is ink width plus a symmetric side bearing. An isolated glyph cannot
        # reveal its true bearings - nothing in the sample says where the pen would
        # start for the NEXT letter - so this is stated as a model, not measured and
        # dressed up. See layout.SIDE_BEARING_EM.
        advance=(ink_right - ink_left) * scale + 2 * side_bearing_px * scale,
        # These two ARE measured, from the printed baseline.
        ascent=max(0.0, (baseline_y - ink_top) * scale),
        descent=max(0.0, (ink_bottom - baseline_y) * scale),
        ink_pixels=cell_ink.ink_pixels,
    )


def extract_page(cell_inks, drop_blue_used: bool = True):
    """Outline every segmented cell on a page. Returns `(outlines, failures)`."""
    outlines: list[GlyphOutline] = []
    failures: list[CellFailure] = []
    for cell_ink in cell_inks:
        result = extract_outline(cell_ink, drop_blue_used)
        if isinstance(result, CellFailure):
            failures.append(result)
        else:
            outlines.append(result)
    return outlines, failures
