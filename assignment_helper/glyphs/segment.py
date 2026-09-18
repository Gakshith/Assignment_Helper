"""Turn a rectified sheet into one ink mask per cell.

Sauvola rather than Otsu, because a phone photo of a sheet has a lighting gradient
across it and a single global threshold eats the dim corner. Sauvola adapts to a local
window, which is exactly the shadow-gradient case in acceptance row 24.

Two things here are easy to get wrong and are handled deliberately:

  * **Padding.** Cells are cropped with `CELL_PAD_FRAC` of slack, so a `g` whose
    descender drops past the printed box is still whole. Ownership is then decided by
    CENTROID against the *unpadded* cell, so the padding picks up your own descender
    without stealing the neighbour's ascender.
  * **Multi-part glyphs.** `i`, `j`, `!`, `?`, `:`, `=` and the quotes are two or more
    components. Every component the cell owns is unioned into one mask, so the dot on
    the `i` is part of the `i` and not discarded as a speck.

I17: every CV import is inside a function body.
"""

from __future__ import annotations

from dataclasses import dataclass

from assignment_helper.glyphs import layout
from assignment_helper.glyphs.errors import CellFailure

#: Sauvola window, in canonical pixels. Roughly a third of a cell: wide enough to hold
#: both ink and paper in every window, narrow enough to track a gradient across a page.
SAUVOLA_WINDOW = 81
SAUVOLA_K = 0.20

#: A component smaller than this fraction of the cell area is a speck - paper grain,
#: JPEG noise, a pencil dot. Small enough to keep the dot of an `i`, which is ~0.15%.
MIN_COMPONENT_AREA_FRAC = 0.0004
#: Ink covering more than this fraction of the padded cell is not a glyph: it is a
#: shadow, a smudge, or a character scribbled out and rewritten.
MAX_INK_AREA_FRAC = 0.55
#: A whole cell with less ink than this is empty.
MIN_CELL_INK_AREA_FRAC = 0.0015

#: Below this fraction of viable cells the run is reported as `incomplete` (not failed).
VIABLE_RATIO_WARN = 0.60


@dataclass
class CellInk:
    """One cell's ink, ready for outlining. `mask` is uint8 0/255, ink = 255."""

    cell: layout.CellBox
    mask: object
    crop_origin: tuple[int, int]
    ink_pixels: int


def drop_non_photo_blue(bgr, enabled: bool = True):
    """Remove the printed blue guides, returning a grayscale image.

    *** THE PREMISE HERE IS UNVERIFIED. See sheet.py. ***
    Whether the printed non-photo blue still reads as blue after this user's printer
    and their phone's auto white balance have both had a go at it has not been tested
    on real paper. This is written so that being wrong is survivable:

      * With `enabled=False` it is a plain luminance conversion, and the pipeline
        still works because the blue is LIGHT and Sauvola drops light things anyway.
      * With `enabled=True` it only ever LIGHTENS pixels that are strongly blue-
        dominant. It can therefore weaken a blue-ink pen stroke, but it cannot
        manufacture ink, so its failure mode is a missing glyph that gets reported —
        not a corrupt one that gets written.

    The correct fix is the one-hour print-and-photograph experiment in plan §C.5.5.
    Until that is run, treat `enabled=True` as an optimisation, not a dependency.
    """
    import cv2
    import numpy as np

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if not enabled:
        return gray

    b = bgr[:, :, 0].astype(np.int16)
    g = bgr[:, :, 1].astype(np.int16)
    r = bgr[:, :, 2].astype(np.int16)

    # Non-photo blue is bright, and its blue and green channels both sit well above
    # red. Requiring all three conditions is what keeps a blue BALLPOINT - which is
    # dark, so it fails the brightness test - out of the mask.
    is_guide = (b - r > 25) & (g - r > 10) & (b > 120)
    out = gray.copy()
    out[is_guide] = 255
    return out


def binarise(gray):
    """Sauvola threshold. Returns uint8 0/255 with ink = 255."""
    import numpy as np
    from skimage.filters import threshold_sauvola

    threshold = threshold_sauvola(gray, window_size=SAUVOLA_WINDOW, k=SAUVOLA_K)
    return ((gray < threshold).astype(np.uint8)) * 255


def segment_cells(
    warped_bgr,
    page: int,
    charset: list[str],
    drop_blue: bool = True,
) -> tuple[list[CellInk], list[CellFailure]]:
    """Segment every cell on one rectified page.

    Returns the cells that produced usable ink and a `CellFailure` for each that did
    not. Nothing raises here: a bad cell is data, not an exception, because one
    smudged `q` must not cost the other 359 samples.
    """
    import cv2
    import numpy as np

    gray = drop_non_photo_blue(warped_bgr, enabled=drop_blue)
    binary = binarise(gray)

    ink: list[CellInk] = []
    failures: list[CellFailure] = []

    for cell in layout.cells_for_page(charset, page):
        x0, y0, x1, y1 = cell.padded()
        crop = binary[y0:y1, x0:x1]
        crop_area = float(crop.shape[0] * crop.shape[1])

        count, labels, stats, centroids = cv2.connectedComponentsWithStats(crop, 8, cv2.CV_32S)

        # Label 0 is the background. Keep a component when its centroid falls inside
        # the UNPADDED cell and it is bigger than a speck.
        keep: list[int] = []
        min_area = MIN_COMPONENT_AREA_FRAC * cell.width * cell.height
        for label in range(1, count):
            cx, cy = centroids[label]
            gx, gy = cx + x0, cy + y0
            if not (cell.left <= gx <= cell.right and cell.top <= gy <= cell.bottom):
                continue
            if stats[label, cv2.CC_STAT_AREA] < min_area:
                continue
            keep.append(label)

        if not keep:
            failures.append(
                CellFailure(cell.ch, cell.repeat, page, "empty", "no ink found in the cell")
            )
            continue

        mask = np.isin(labels, keep).astype(np.uint8) * 255
        ink_pixels = int(np.count_nonzero(mask))

        if ink_pixels < MIN_CELL_INK_AREA_FRAC * cell.width * cell.height:
            failures.append(
                CellFailure(cell.ch, cell.repeat, page, "speck",
                            f"only {ink_pixels} ink pixels")
            )
            continue
        if ink_pixels > MAX_INK_AREA_FRAC * crop_area:
            failures.append(
                CellFailure(cell.ch, cell.repeat, page, "flooded",
                            f"{ink_pixels / crop_area:.0%} of the cell is ink")
            )
            continue

        ys, xs = np.nonzero(mask)
        if xs.min() == 0 or ys.min() == 0 or xs.max() == mask.shape[1] - 1 \
                or ys.max() == mask.shape[0] - 1:
            failures.append(
                CellFailure(cell.ch, cell.repeat, page, "touches-edge",
                            "the mark runs off the edge of the cell and is cut off")
            )
            continue

        ink.append(CellInk(cell=cell, mask=mask, crop_origin=(x0, y0), ink_pixels=ink_pixels))

    return ink, failures
