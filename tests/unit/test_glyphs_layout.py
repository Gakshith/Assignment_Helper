"""The canonical sheet geometry and the charset. Pure arithmetic, no CV, fast."""

from __future__ import annotations

import itertools

import pytest

from assignment_helper.glyphs import layout, paths
from assignment_helper.glyphs.charset import CHARSET, REPEATS, assert_charset_fits
from assignment_helper.glyphs.errors import ProfileWriteError


def test_charset_exactly_fills_a_page() -> None:
    """The guard that stops a 91st character being silently sliced away."""
    assert_charset_fits()
    # Derived, not hardcoded: the grid is a design parameter. It grew from 9x10=90
    # to 11x12=132 when Greek and the maths operators joined the charset.
    assert len(CHARSET) == layout.CELLS_PER_PAGE


def test_assert_charset_fits_checks_the_charset_it_is_given() -> None:
    """Regression: it used to validate the global set no matter what it was passed,
    which made it useless for exactly the custom set it was meant to guard."""
    short = len(CHARSET) - 1
    with pytest.raises(ValueError, match=f"{short} characters"):
        assert_charset_fits(CHARSET[:short])
    with pytest.raises(ValueError, match="duplicates"):
        assert_charset_fits(["a"] * layout.CELLS_PER_PAGE)


def test_every_page_has_a_full_grid_of_cells() -> None:
    for page in range(REPEATS):
        cells = layout.cells_for_page(CHARSET, page)
        assert len(cells) == layout.CELLS_PER_PAGE
        assert [c.ch for c in cells] == CHARSET
        assert {c.repeat for c in cells} == {page}


def test_cells_do_not_overlap_and_stay_on_the_page() -> None:
    cells = layout.cells_for_page(CHARSET, 0)
    for cell in cells:
        assert 0 <= cell.left < cell.right <= layout.PAGE_W_PX
        assert 0 <= cell.top < cell.bottom <= layout.PAGE_H_PX

    for a, b in itertools.pairwise(cells):
        if a.row == b.row:
            assert a.right <= b.left + 1e-6


def test_the_guides_sit_in_a_sane_order_inside_the_cell() -> None:
    """ascender above baseline above descender, all inside the cell. If this ever
    inverts, every recovered ascent and descent silently swaps sign."""
    cell = layout.cells_for_page(CHARSET, 0)[0]
    assert cell.top < cell.ascender_y < cell.baseline_y < cell.descender_y < cell.bottom
    assert cell.em_px > 0


def test_padding_widens_the_crop_on_every_side_for_an_interior_cell() -> None:
    """A descender crossing the cell boundary must not be truncated."""
    cells = layout.cells_for_page(CHARSET, 0)
    interior = next(c for c in cells if 0 < c.row < layout.ROWS - 1 and 0 < c.col < layout.COLS - 1)
    x0, y0, x1, y1 = interior.padded()
    assert x0 < interior.left and y0 < interior.top
    assert x1 > interior.right and y1 > interior.bottom


def test_marker_ids_are_unique_across_pages() -> None:
    seen: set[int] = set()
    for page in range(REPEATS):
        ids = layout.marker_ids_for_page(page)
        assert len(ids) == 4
        assert not (seen & set(ids)), "two pages share a marker id"
        seen.update(ids)
    assert max(seen) < 50, "DICT_4X4_50 only has 50 ids"


def test_markers_do_not_sit_on_the_writing_grid() -> None:
    """A marker overlapping a cell would be segmented as ink and would also be
    scribbled on by the user."""
    for x0, y0, x1, y1 in layout.marker_rects():
        overlaps_grid = (
            x1 > layout.GRID_LEFT_PX
            and x0 < layout.GRID_RIGHT_PX
            and y1 > layout.GRID_TOP_PX
            and y0 < layout.GRID_BOTTOM_PX
        )
        assert not overlaps_grid


# ------------------------------------------------------------------ profile paths


def test_profile_ids_that_would_escape_the_directory_are_refused() -> None:
    """HandStyle.profile is a free string that reaches the filesystem."""
    for bad in ("../../etc/passwd", "..", "a/b", "with space", "", "dot.name", "/abs"):
        with pytest.raises(ProfileWriteError):
            paths.validate_profile_id(bad)


def test_ordinary_profile_ids_are_accepted() -> None:
    for good in ("reference", "my-hand", "akshith_2026", "a", "A1"):
        assert paths.validate_profile_id(good) == good


def test_profiles_never_live_inside_the_repo(tmp_path, monkeypatch) -> None:
    """Invariant I9. The repo is public; handwriting never enters it."""
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    resolved = paths.profile_json_path("my-hand").resolve()
    repo_root = __import__("pathlib").Path(__file__).resolve().parents[2]
    assert repo_root not in resolved.parents
