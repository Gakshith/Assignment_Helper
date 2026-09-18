"""Find the four corner markers and warp the photo back to the canonical sheet.

The contract with the rest of the pipeline is narrow: give this module a photo, get
back an image the exact size of `layout.PAGE_W_PX x PAGE_H_PX` in which every
`CellBox` is where `layout.py` says it is. Everything downstream can then work in
canonical coordinates and never think about perspective again.

Acceptance row 4 is the whole reason this module raises rather than guesses: with
fewer than four markers there is no homography, and the honest answer is a named
error that says which markers WERE found. Three markers would let us fit an affine
transform, and that is exactly the tempting half-measure this refuses — an affine fit
cannot represent perspective, so it would silently produce a skewed sheet and a
profile full of subtly sheared glyphs.

I17: every CV import is inside a function body.
"""

from __future__ import annotations

from pathlib import Path

from assignment_helper.glyphs import layout
from assignment_helper.glyphs.errors import MarkersNotFound, SheetUnreadable

#: Below this the warp is refused outright: a sheet photographed smaller than roughly
#: a third of the canonical size cannot carry enough pixels per cell to outline.
MIN_LONG_EDGE_PX = 900

#: DICT_4X4_50 holds 50 ids and a page burns 4, so page ids stay unique to 12 pages.
MAX_PAGES = 12


def load_image(source: Path | bytes):
    """Decode a photo to BGR. Raises `SheetUnreadable` rather than returning None.

    cv2.imread returns None for a missing or undecodable file — the classic silent
    failure this codebase forbids (I5), so it is converted here and never propagated
    as a None.
    """
    import cv2
    import numpy as np

    if isinstance(source, bytes):
        buffer = np.frombuffer(source, dtype=np.uint8)
        image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        where = f"the uploaded image ({len(source)} bytes)"
    else:
        path = Path(source)
        if not path.is_file():
            raise SheetUnreadable(
                f"There is no image at {path}.",
                detail="The tracing-sheet photo must be a readable file.",
            )
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        where = str(path)

    if image is None or image.size == 0:
        raise SheetUnreadable(
            f"Could not decode {where} as an image.",
            detail="Expected a JPEG, PNG or HEIC-converted photo of the tracing sheet.",
        )
    if max(image.shape[:2]) < MIN_LONG_EDGE_PX:
        raise SheetUnreadable(
            f"That photo is too small to extract glyphs from "
            f"({image.shape[1]}x{image.shape[0]} px).",
            detail=(
                f"The longest edge must be at least {MIN_LONG_EDGE_PX} px. "
                "Photograph the sheet closer, or turn off any downscaling in the "
                "camera app."
            ),
        )
    return image


def detect_markers(image, page: int | None = None) -> tuple[dict[int, object], int]:
    """Detect ArUco markers and return `{marker_id: 4x2 corners}` plus the page index.

    When `page` is None the page is inferred from whichever marker ids were seen,
    because the user photographs four sheets and should not have to tell us which is
    which. Inference takes the page with the most markers present.
    """
    import cv2

    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    params = cv2.aruco.DetectorParameters()
    # A phone photo of a printed sheet is high resolution and often slightly soft.
    # Refining the corners with the subpixel method is what holds the homography
    # together at a steep angle; it is cheap next to decoding the JPEG.
    params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
    detector = cv2.aruco.ArucoDetector(dictionary, params)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    corners, ids, _rejected = detector.detectMarkers(gray)

    found: dict[int, object] = {}
    if ids is not None:
        for marker_corners, marker_id in zip(corners, ids.flatten(), strict=True):
            found[int(marker_id)] = marker_corners.reshape(4, 2)

    if page is None:
        best_page, best_hits = 0, -1
        for candidate in range(MAX_PAGES):
            hits = sum(1 for m in layout.marker_ids_for_page(candidate) if m in found)
            if hits > best_hits:
                best_page, best_hits = candidate, hits
        page = best_page

    return found, page


def _outermost_corner(marker_corners, centre):
    """The one of a marker's four corners furthest from the centre of the marker set.

    Chosen geometrically rather than by trusting cv2.aruco's corner ORDER. The order
    is documented as clockwise from the marker's own top-left, but "top-left" is
    defined in the marker's frame, so a sheet photographed upside down or in portrait
    rotates it. Distance from the centroid is true under any rotation, and the four
    outer corners are exactly the four extreme points of the sheet.
    """
    import numpy as np

    pts = np.asarray(marker_corners, dtype=np.float64).reshape(4, 2)
    distances = np.hypot(pts[:, 0] - centre[0], pts[:, 1] - centre[1])
    return pts[int(np.argmax(distances))]


def find_reference_points(image, page: int | None = None):
    """The four (source, destination) point pairs for the homography.

    Raises `MarkersNotFound` when fewer than four of the page's markers are present,
    naming what was found. No partial result, no affine fallback.
    """
    import numpy as np

    found, page = detect_markers(image, page)
    expected = layout.marker_ids_for_page(page)
    present = [m for m in expected if m in found]

    if len(present) < 4:
        stray = sorted(set(found) - set(expected))
        raise MarkersNotFound(
            "Could not find 4 corner markers on the tracing sheet — "
            f"found {len(present)} of 4.",
            found=present,
            expected=expected,
            detail=(
                "Re-photograph the sheet with all four black corner squares fully in "
                "frame, flat, and not covered by a hand or a shadow."
                + (f" Markers from another page were visible: {stray}." if stray else "")
            ),
        )

    centre = np.mean(
        np.concatenate([np.asarray(found[m]).reshape(4, 2) for m in expected]), axis=0
    )
    src = np.array(
        [_outermost_corner(found[m], centre) for m in expected], dtype=np.float32
    )
    dst = np.array(layout.marker_outer_corners(), dtype=np.float32)
    return src, dst, page


def warp_to_canonical(image, page: int | None = None):
    """Rectify the photo to canonical sheet coordinates. Returns `(warped, page)`.

    `findHomography` with RANSAC rather than `getPerspectiveTransform`: with exactly
    four points the two agree, but RANSAC reports failure as a None H instead of
    producing a degenerate matrix when the four points are collinear — which is what
    a badly creased sheet looks like.
    """
    import cv2
    import numpy as np

    src, dst, page = find_reference_points(image, page)
    homography, _mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)

    if homography is None or not np.all(np.isfinite(homography)):
        raise MarkersNotFound(
            "Found 4 corner markers but they do not describe a flat sheet.",
            found=layout.marker_ids_for_page(page),
            expected=layout.marker_ids_for_page(page),
            detail=(
                "The markers were probably detected on a folded or heavily curved "
                "page. Flatten the sheet and photograph it again."
            ),
        )

    warped = cv2.warpPerspective(
        image,
        homography,
        (layout.PAGE_W_PX, layout.PAGE_H_PX),
        flags=cv2.INTER_CUBIC,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=(255, 255, 255),
    )
    return warped, page
