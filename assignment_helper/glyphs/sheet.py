"""Generate the printable tracing sheet.

Four pages, 90 labelled cells each, four black ArUco markers per page for
rectification. Everything the user is meant to ignore is printed in non-photo blue so
the colour-drop step can remove it; the markers stay black because the detector needs
them and because they must survive whatever the colour-drop does.

I17: `cv2` and `numpy` are imported inside function bodies only. Pillow and img2pdf
are ordinary dependencies of the product and may be imported normally, but nothing in
this module is on the serve path anyway.

*** UNVERIFIED, AND IT SITS UNDER THE WHOLE PIPELINE ***
Whether non-photo blue actually survives this user's printer and their phone's white
balance has NOT been tested. Plan §C.5.5 calls it a one-hour experiment and that hour
has not been spent. Modern phone cameras correct colour aggressively and may render
this blue as plain grey, in which case the colour drop removes nothing, or worse,
removes some of the pencil. That is why `drop_blue` is a flag and why the pipeline is
built to work — slightly worse — with it off. Do not treat the colour drop as load-
bearing until somebody prints this and photographs it.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from assignment_helper.glyphs import layout
from assignment_helper.glyphs.charset import CHARSET, REPEATS, assert_charset_fits, label_for

#: Classic non-photo blue. Light enough that a luminance threshold also drops it, which
#: is the fallback when the colour drop is disabled or when the camera greys it out.
NON_PHOTO_BLUE = (164, 221, 237)
#: The guides are drawn lighter still, so they sit well above any Sauvola threshold.
GUIDE_BLUE = (186, 229, 242)
BLACK = (0, 0, 0)
WHITE = (255, 255, 255)


def _font(size: int):
    """The label font. Pillow's bundled default is used deliberately: shipping a font
    file for a sheet nobody reads closely is not worth the licence paperwork."""
    from PIL import ImageFont

    return ImageFont.load_default(size=size)


def _paste_markers(image, page: int) -> None:
    """Paste the four ArUco markers for this page, in black on white."""
    import cv2
    import numpy as np
    from PIL import Image

    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    ids = layout.marker_ids_for_page(page)
    # The marker is square, so its height is implied by its width; _y1 is unpacked
    # only to keep the rect shape readable at the call site.
    for marker_id, (x0, y0, x1, _y1) in zip(ids, layout.marker_rects(), strict=True):
        bitmap = cv2.aruco.generateImageMarker(dictionary, marker_id, x1 - x0)
        image.paste(Image.fromarray(np.dstack([bitmap] * 3)), (x0, y0))


def _draw_cell(draw, cell: layout.CellBox, label_font, guide_font) -> None:
    """One cell: its label, its three guides, and a corner tick.

    The baseline is solid and the ascender/descender guides are dashed, so the user can
    see at a glance which line to sit the letter on. Getting the baseline right is what
    makes the recovered ascent and descent mean anything.
    """
    left, top = cell.left, cell.top
    right, bottom = cell.right, cell.bottom

    draw.rectangle([left, top, right, bottom], outline=GUIDE_BLUE, width=2)

    for y in (cell.ascender_y, cell.descender_y):
        x = left + 8
        while x < right - 8:
            draw.line([(x, y), (min(x + 10, right - 8), y)], fill=GUIDE_BLUE, width=2)
            x += 20

    draw.line([(left + 8, cell.baseline_y), (right - 8, cell.baseline_y)],
              fill=NON_PHOTO_BLUE, width=3)

    draw.text((left + 10, top + 6), label_for(cell.ch), font=label_font, fill=NON_PHOTO_BLUE)

    tick = 14
    draw.line([(left + 10, cell.baseline_y), (left + 10, cell.baseline_y - tick)],
              fill=NON_PHOTO_BLUE, width=3)
    _ = guide_font


def build_page(page: int, charset: list[str] | None = None):
    """Render one sheet page as a Pillow RGB image at `layout.DPI`."""
    from PIL import Image, ImageDraw

    chars = charset if charset is not None else CHARSET
    assert_charset_fits(chars)

    image = Image.new("RGB", (layout.PAGE_W_PX, layout.PAGE_H_PX), WHITE)
    _paste_markers(image, page)
    draw = ImageDraw.Draw(image)

    label_font = _font(26)
    guide_font = _font(20)
    title_font = _font(34)

    draw.text(
        (layout.GRID_LEFT_PX, layout.MARKER_MARGIN_PX + 40),
        f"assignment-helper tracing sheet  -  page {page + 1} of {REPEATS}  -  "
        f"write ONE character per box, sitting on the solid line",
        font=title_font,
        fill=NON_PHOTO_BLUE,
    )
    draw.text(
        (layout.GRID_LEFT_PX, layout.PAGE_H_PX - layout.MARKER_MARGIN_PX - 60),
        "Use a dark pen. Do not write over the black corner squares. "
        "Photograph the whole sheet, flat and evenly lit.",
        font=guide_font,
        fill=NON_PHOTO_BLUE,
    )

    for cell in layout.cells_for_page(chars, page):
        _draw_cell(draw, cell, label_font, guide_font)

    return image


def build_pages(charset: list[str] | None = None) -> list:
    """All `REPEATS` pages of the sheet."""
    return [build_page(p, charset) for p in range(REPEATS)]


def write_sheet_pdf(destination: Path, charset: list[str] | None = None) -> Path:
    """Write the whole tracing sheet as a PDF.

    Pages are rasterised by Pillow and assembled by img2pdf — the same img2pdf the
    export path already depends on, so the sheet costs no new dependency. The PNGs go
    through a temp directory and are removed on the way out, including on failure:
    a tracing sheet is not secret, but a stray one in /tmp is still the user's.
    """
    from PIL import Image

    destination = Path(destination)
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        from assignment_helper.glyphs.errors import ProfileWriteError

        raise ProfileWriteError(
            f"Could not create the directory for the tracing sheet at {destination.parent}.",
            detail=str(exc),
        ) from exc

    pages: list[Image.Image] = build_pages(charset)
    with tempfile.TemporaryDirectory(prefix="ah-sheet-") as tmp:
        png_paths: list[str] = []
        for i, page in enumerate(pages):
            p = os.path.join(tmp, f"page{i}.png")
            page.save(p, "PNG", dpi=(layout.DPI, layout.DPI))
            png_paths.append(p)

        import img2pdf

        layout_fn = img2pdf.get_fixed_dpi_layout_fun((layout.DPI, layout.DPI))
        pdf_bytes = img2pdf.convert(png_paths, layout_fun=layout_fn)

    # Atomic, like every other write in this package (I10): a half-written PDF that
    # opens to garbage is worse than no PDF.
    fd, tmp_pdf = tempfile.mkstemp(dir=str(destination.parent), suffix=".pdf.tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(pdf_bytes)
        os.replace(tmp_pdf, destination)
    except BaseException:
        # Not a silent swallow: the exception propagates on the next line. This only
        # removes the temp file so a failed write leaves nothing behind.
        Path(tmp_pdf).unlink(missing_ok=True)
        raise
    return destination
