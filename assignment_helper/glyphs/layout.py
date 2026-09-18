"""The canonical tracing-sheet geometry. Pure arithmetic — no CV stack, no I/O.

This module is the single definition of where everything on the sheet is. `sheet.py`
draws from it and `rectify.py`/`segment.py` read from it. If the writer and the reader
each carried their own copy of the grid, a one-cell drift between them would show up
only as mysteriously bad glyphs, so they share this one.

Coordinates here are pixels of the CANONICAL sheet — the rectified, head-on image that
`rectify.warp_to_canonical` produces. The printed PDF is rendered from the same numbers
at the same scale, which is why a cell index means the same thing on paper and after
the homography.

Layout of one page:

    +--------------------------------------------------+
    |  [M0]                                      [M1]   |   markers at the four corners
    |                                                   |
    |   +----------+----------+   ... 9 columns         |
    |   |   a      |   b      |                         |   each cell:
    |   | - - - - -| - - - - -|   <- ascender guide     |     label in the top-left
    |   | ________ | ________ |   <- BASELINE (solid)   |     three printed guides
    |   | - - - - -| - - - - -|   <- descender guide    |     all in non-photo blue
    |   +----------+----------+                         |
    |            ... 10 rows                            |
    |  [M3]                                      [M2]   |
    +--------------------------------------------------+

Marker ids are page-specific (page p uses 4p, 4p+1, 4p+2, 4p+3) so a photo identifies
which page it is rather than trusting the user to upload them in order. DICT_4X4_50
gives 50 ids, so this addressing supports 12 pages; we use 4.
"""

from __future__ import annotations

from dataclasses import dataclass

#: The sheet is authored at 300 dpi on US Letter. 8.5 x 11 in -> 2550 x 3300 px.
DPI = 300
PAGE_W_PX = 2550
PAGE_H_PX = 3300

#: Units per em in the emitted outlines. 1000 is the PostScript convention and is what
#: `GlyphOutlineProvider.unitsPerEm` reports to paint.
UNITS_PER_EM = 1000

#: Marker square side, and the margin from the page edge to the marker's outer corner.
MARKER_PX = 200
MARKER_MARGIN_PX = 90

#: The writing grid. 13 x 12 = 156 cells; the charset uses 145 and the rest stay blank.
#:
#: Was 9 x 10 = 90, sized for a Latin-only charset, then 11 x 12 when Greek and the
#: operators arrived. More PAGES was always the wrong trade — M2's gate is "build your
#: profile in under ten minutes", and an extra sheet costs the student far more than a
#: slightly smaller cell costs the segmenter.
#:
#: The grid no longer has to match the charset EXACTLY. It did, and that meant every
#: character added forced a grid change and a round of test edits; spare cells simply
#: print blank. Roughly 14.6 mm per cell at Letter/300dpi, still ample for one glyph.
COLS = 13
ROWS = 12
CELLS_PER_PAGE = COLS * ROWS

#: The grid's bounding box on the page, chosen to clear the markers top and bottom.
GRID_LEFT_PX = 150
GRID_TOP_PX = 420
GRID_RIGHT_PX = PAGE_W_PX - 150
GRID_BOTTOM_PX = PAGE_H_PX - 420

CELL_W_PX = (GRID_RIGHT_PX - GRID_LEFT_PX) / COLS
CELL_H_PX = (GRID_BOTTOM_PX - GRID_TOP_PX) / ROWS

#: Where the baseline sits inside a cell, as a fraction of cell height from its top.
BASELINE_FRAC = 0.70
#: The em height as a fraction of cell height. The ascender guide sits 0.75 em above
#: the baseline and the descender guide 0.25 em below, matching normal font proportions.
EM_FRAC = 0.55
ASCENDER_EM = 0.75
DESCENDER_EM = 0.25

#: Padding applied when cropping a cell for segmentation, as a fraction of cell size.
#: This is why a descender that crosses the cell boundary is not truncated. Ink is
#: gathered from the padded crop; ownership is decided by centroid on the unpadded cell.
CELL_PAD_FRAC = 0.18

#: The side bearing given to each glyph, in em units. An isolated glyph in a box cannot
#: reveal its true side bearings - nothing in the sample says where the pen would have
#: started for the NEXT letter. We apply a symmetric bearing and say so, rather than
#: inventing a per-glyph number that looks measured and is not.
SIDE_BEARING_EM = 0.06


@dataclass(frozen=True)
class CellBox:
    """One cell's canonical geometry, in canonical-sheet pixels."""

    index: int
    row: int
    col: int
    ch: str
    repeat: int
    page: int

    left: float
    top: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.left + self.width

    @property
    def bottom(self) -> float:
        return self.top + self.height

    @property
    def baseline_y(self) -> float:
        """Canonical y of the printed baseline. Glyph ascent/descent are measured
        from here, which is what makes the recovered metrics real rather than
        bounding-box guesses."""
        return self.top + self.height * BASELINE_FRAC

    @property
    def em_px(self) -> float:
        """One em, in canonical pixels. The px -> em-unit scale is UNITS_PER_EM/em_px."""
        return self.height * EM_FRAC

    @property
    def ascender_y(self) -> float:
        return self.baseline_y - self.em_px * ASCENDER_EM

    @property
    def descender_y(self) -> float:
        return self.baseline_y + self.em_px * DESCENDER_EM

    def padded(self) -> tuple[int, int, int, int]:
        """The crop rect (x0, y0, x1, y1) used for segmentation, clamped to the page."""
        pad_x = self.width * CELL_PAD_FRAC
        pad_y = self.height * CELL_PAD_FRAC
        # round() already returns an int for a float argument.
        x0 = max(0, round(self.left - pad_x))
        y0 = max(0, round(self.top - pad_y))
        x1 = min(PAGE_W_PX, round(self.right + pad_x))
        y1 = min(PAGE_H_PX, round(self.bottom + pad_y))
        return x0, y0, x1, y1


def marker_ids_for_page(page: int) -> list[int]:
    """The four marker ids on `page`, in TL, TR, BR, BL order."""
    base = 4 * page
    return [base, base + 1, base + 2, base + 3]


def marker_outer_corners() -> list[tuple[float, float]]:
    """Canonical position of each marker's OUTERMOST corner, in TL, TR, BR, BL order.

    The outer corner is used (rather than the marker centre) because it is the point
    the detector localises most precisely and because it puts the four reference
    points as far apart as the page allows, which is what keeps the homography stable
    at a steep angle.
    """
    m = MARKER_MARGIN_PX
    return [
        (float(m), float(m)),
        (float(PAGE_W_PX - m), float(m)),
        (float(PAGE_W_PX - m), float(PAGE_H_PX - m)),
        (float(m), float(PAGE_H_PX - m)),
    ]


def marker_rects() -> list[tuple[int, int, int, int]]:
    """Where each marker square is drawn, (x0, y0, x1, y1), in TL, TR, BR, BL order."""
    m = MARKER_MARGIN_PX
    s = MARKER_PX
    return [
        (m, m, m + s, m + s),
        (PAGE_W_PX - m - s, m, PAGE_W_PX - m, m + s),
        (PAGE_W_PX - m - s, PAGE_H_PX - m - s, PAGE_W_PX - m, PAGE_H_PX - m),
        (m, PAGE_H_PX - m - s, m + s, PAGE_H_PX - m),
    ]


def cells_for_page(charset: list[str], page: int) -> list[CellBox]:
    """Every cell on `page`. One page carries one full repeat of `charset`.

    Repeat index == page index: page 0 is the first sample of every character, page 3
    the fourth. That keeps a lost page costing one variant of everything rather than
    every variant of one quarter of the alphabet.
    """
    cells: list[CellBox] = []
    for i, ch in enumerate(charset[:CELLS_PER_PAGE]):
        row, col = divmod(i, COLS)
        cells.append(
            CellBox(
                index=i,
                row=row,
                col=col,
                ch=ch,
                repeat=page,
                page=page,
                left=GRID_LEFT_PX + col * CELL_W_PX,
                top=GRID_TOP_PX + row * CELL_H_PX,
                width=CELL_W_PX,
                height=CELL_H_PX,
            )
        )
    return cells
