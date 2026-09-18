"""M2 acceptance: outline extraction from a tracing sheet.

Every sheet in this file is GENERATED from the OFL reference font (invariant I9 — the
repo is public and no real handwriting may enter it). That is not a compromise: because
the glyphs are drawn from a font at a known size on a known baseline, the true advance,
ascent and descent of every cell are known exactly, so these tests assert on real
numbers rather than on "it did not crash".

These are slow by nature — a sheet is 2550x3300 and there are CELLS_PER_PAGE cells on it — so the
module builds each sheet once and shares it.
"""

from __future__ import annotations

import json

import pytest

from assignment_helper.glyphs import outline as outline_mod
from assignment_helper.glyphs import pipeline, profile as profile_mod, rectify, segment
from assignment_helper.glyphs.charset import CHARSET
from assignment_helper.glyphs.errors import MarkersNotFound, SheetUnreadable
from support import synthetic_sheet as synth


@pytest.fixture(scope="module")
def clean_page():
    """A filled page 0 and the ground-truth metrics of everything written on it."""
    return synth.render_filled_page(0)


@pytest.fixture(scope="module")
def extracted(clean_page):
    """The round trip: render -> photograph -> rectify -> segment -> outline."""
    image, truth = clean_page
    bgr = synth.photograph(image, scale=0.55)
    warped, page = rectify.warp_to_canonical(bgr)
    inks, seg_failures = segment.segment_cells(warped, page, CHARSET)
    outlines, outline_failures = outline_mod.extract_page(inks)
    return outlines, seg_failures + outline_failures, truth


# ------------------------------------------------------- the round trip


def test_the_round_trip_recovers_every_character(extracted) -> None:
    outlines, failures, _truth = extracted
    recovered = {o.ch for o in outlines}
    missing = sorted(set(CHARSET) - recovered)
    assert not missing, f"lost {len(missing)} characters: {missing}; failures={failures}"


def test_recovered_ascent_and_descent_match_the_font(extracted) -> None:
    """Ascent and descent are MEASURED, from the baseline the sheet printed.

    This is the thing outline-first buys and it is worth asserting tightly: the
    printed baseline gives an absolute reference, so these are real distances rather
    than bounding-box guesses.

    The tolerance is `max(8% of the value, 20 units)`. The absolute floor is there
    because a purely relative bound is meaningless on a tiny value: a `B` whose
    descent is 81 units (0.08 em, the font's overshoot below the baseline) comes back
    as 72, and that 9-unit gap is the threshold eroding one anti-aliased edge pixel.
    Nine thousandths of an em is smaller than a pixel at any size this ever renders
    at, so bounding it relatively would be asserting on noise.
    """
    outlines, _failures, truth = extracted
    bad: list[str] = []
    for o in outlines:
        t = truth[o.ch]
        if t.ascent > 80 and abs(o.ascent - t.ascent) > max(0.08 * t.ascent, 20):
            bad.append(f"{o.ch!r} ascent {o.ascent:.0f} vs {t.ascent:.0f}")
        if t.descent > 80 and abs(o.descent - t.descent) > max(0.08 * t.descent, 20):
            bad.append(f"{o.ch!r} descent {o.descent:.0f} vs {t.descent:.0f}")
    assert not bad, "metrics drifted: " + "; ".join(bad)


def test_recovered_outlines_sit_in_a_sane_em_box(extracted) -> None:
    """y-up, baseline at 0, origin at the pen start — the GlyphOutlineProvider contract.

    A sign error here is invisible in a unit test of the maths and catastrophic on the
    page, so it is asserted directly: ascenders must be POSITIVE y.
    """
    outlines, _failures, _truth = extracted
    for o in outlines:
        xs = [x for _, points in o.contours for x, _ in points]
        ys = [y for _, points in o.contours for _, y in points]
        assert min(xs) >= -1.0, f"{o.ch!r} has ink left of the pen origin"
        assert max(ys) > 0, f"{o.ch!r} has no ink above the baseline — y is upside down"
        assert max(ys) < 1400, f"{o.ch!r} is taller than 1.4 em"
        assert min(ys) > -600, f"{o.ch!r} descends more than 0.6 em"


def test_advance_is_positive_and_wider_than_the_ink(extracted) -> None:
    """Advance is a MODEL, not a measurement, and is asserted as such.

    An isolated glyph in a box cannot reveal its true advance — nothing in the sample
    says where the pen would start for the next letter — so `outline.py` uses ink
    width plus a symmetric side bearing. Measured against Caveat it runs ~24% wide,
    but ~19 of those points are the reference font's own overhang (its ink is already
    1.19x its advance, with no pipeline involved). So this asserts the property that
    must hold — advance covers the ink — and not a fake accuracy number.
    """
    outlines, _failures, _truth = extracted
    for o in outlines:
        xs = [x for _, points in o.contours for x, _ in points]
        assert o.advance > 0
        assert o.advance >= (max(xs) - min(xs)) - 1.0, f"{o.ch!r} advance clips its own ink"


# ------------------------------------------------------- holes survive


@pytest.mark.parametrize("ch", ["o", "a", "e", "d", "g", "p", "q", "O", "0"])
def test_counters_survive_extraction(extracted, ch: str) -> None:
    """RETR_CCOMP, not RETR_EXTERNAL. Without the hierarchy every `o` is a blob."""
    outlines, _failures, _truth = extracted
    sample = next((o for o in outlines if o.ch == ch), None)
    assert sample is not None, f"{ch!r} was not recovered at all"
    assert sample.hole_count >= 1, f"{ch!r} lost its counter — it extracted as a solid blob"


def test_a_glyph_with_no_counter_gains_no_holes(extracted) -> None:
    """The mirror of the above: if everything has a hole, the hierarchy is being
    misread and the test above would pass for the wrong reason."""
    outlines, _failures, _truth = extracted
    for ch in ("l", "v", "w", "-"):
        sample = next((o for o in outlines if o.ch == ch), None)
        if sample is not None:
            assert sample.hole_count == 0, f"{ch!r} gained a counter it does not have"


# ------------------------------------------------------- row 4: missing markers


def test_row4_three_markers_is_a_named_failure_and_writes_nothing(tmp_path, monkeypatch):
    """Acceptance row 4. Fewer than 4 markers => a NAMED error naming what was found,
    and NO profile.json on disk."""
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    image = synth.blank_marker_page(0, keep=3)
    bgr = synth.photograph(image, scale=0.55)

    with pytest.raises(MarkersNotFound) as caught:
        pipeline.extract([synth.encode_png(bgr)], "row4-hand")

    problem = caught.value.as_problem()
    assert problem["code"] == "glyphs.markers-not-found"
    assert "could not find 4 corner markers" in problem["message"].lower()
    assert len(problem["found"]) < 4
    assert problem["missing"], "the error must say WHICH markers were missing"

    assert not list(tmp_path.rglob("glyphs.json")), (
        "a profile was written despite a hard failure — never a half-built profile"
    )


def test_row4_a_blurry_sheet_fails_by_name_and_writes_nothing(tmp_path, monkeypatch):
    """The blurry case. Whatever it fails on, it must be a NAMED glyph error and it
    must leave no profile behind."""
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    image, _truth = synth.render_filled_page(0)
    bgr = synth.photograph(image, blur=14, scale=0.35)

    from assignment_helper.glyphs.errors import GlyphExtractionError

    with pytest.raises(GlyphExtractionError) as caught:
        pipeline.extract([synth.encode_png(bgr)], "blurry-hand")

    assert caught.value.code.startswith("glyphs.")
    assert caught.value.message
    assert not list(tmp_path.rglob("glyphs.json"))


def test_an_undecodable_upload_is_named_not_a_crash(tmp_path, monkeypatch) -> None:
    """cv2.imdecode returns None for junk. Returning that None would be the silent
    failure I5 forbids."""
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    with pytest.raises(SheetUnreadable):
        pipeline.extract([b"this is not an image"], "junk-hand")
    assert not list(tmp_path.rglob("glyphs.json"))


# ------------------------------------------------------- row 24: off-axis + shadow


@pytest.mark.parametrize(
    ("angle", "shadow", "must_pass"),
    [
        (0, 0.0, True),
        (20, 0.0, True),
        (35, 0.0, True),
        (20, 0.35, True),   # the shadow-gradient case Sauvola exists for
        (50, 0.0, False),   # beyond spec: allowed to fail, but only BY NAME
    ],
    ids=["0deg", "20deg", "35deg", "20deg+shadow", "50deg-beyond-spec"],
)
def test_row24_off_axis_sheets(tmp_path, monkeypatch, angle, shadow, must_pass) -> None:
    """Acceptance row 24: up to ~35 degrees off-axis must work. 50 degrees is past
    what the sheet promises — it is allowed to fail, but never silently and never
    with a half-written profile."""
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    image, _truth = synth.render_filled_page(0)
    bgr = synth.photograph(image, angle_deg=angle, shadow=shadow, scale=0.55)

    from assignment_helper.glyphs.errors import GlyphExtractionError

    try:
        result = pipeline.extract([synth.encode_png(bgr)], f"angle{angle}")
    except GlyphExtractionError as exc:
        assert not must_pass, f"{angle} deg should have worked but raised {exc.code}: {exc}"
        assert exc.code.startswith("glyphs.")
        assert not list(tmp_path.rglob("glyphs.json"))
        return

    assert must_pass or True  # a pass beyond spec is a bonus, not a failure
    assert result.viable_ratio >= 0.60, (
        f"{angle} deg recovered only {result.viable_ratio:.0%} of the charset"
    )


# ------------------------------------------------------- the profile on disk


def test_a_full_run_writes_one_atomic_loadable_profile(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    photos = []
    for page in range(2):  # two pages is enough to prove multi-page merging
        image, _truth = synth.render_filled_page(page, jitter=0.03)
        photos.append(synth.encode_png(synth.photograph(image, scale=0.55)))

    result = pipeline.extract(photos, "round-trip")

    written = result.written_to
    assert written is not None and written.is_file()
    assert written.name == "glyphs.json"
    # No temp files left behind by the atomic write (I10).
    assert not list(written.parent.glob(".glyphs-*.tmp"))

    on_disk = json.loads(written.read_text(encoding="utf-8"))
    assert on_disk["schemaVersion"] == profile_mod.SCHEMA_VERSION
    assert on_disk["unitsPerEm"] == 1000
    assert on_disk["status"] == "complete"
    assert on_disk["coverage"]["covered"] == len(CHARSET)
    assert sorted(on_disk["extraction"]["pagesRead"]) == [0, 1]
    # The unverified premise is recorded on every profile, not just in a docstring.
    assert on_disk["extraction"]["colourDropVerifiedOnPaper"] is False

    assert profile_mod.load_profile("round-trip")["profileId"] == "round-trip"


def test_the_profile_satisfies_the_frozen_provider_contract(tmp_path, monkeypatch) -> None:
    """web/src/render/geometry.ts is FROZEN and this file has to be loadable by it.

    GlyphMetricsProvider needs advance/ascent/descent, variantCount and substitute.
    GlyphOutlineProvider needs contours and unitsPerEm. Asserted field by field, so a
    rename here fails in Python rather than as an undefined in the browser.
    """
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    photos = [
        synth.encode_png(synth.photograph(synth.render_filled_page(p)[0], scale=0.55))
        for p in range(2)
    ]
    built = pipeline.extract(photos, "contract").profile

    assert isinstance(built["unitsPerEm"], int)
    assert isinstance(built["substitutions"], dict)  # -> substitute(ch)

    for ch, glyph in built["glyphs"].items():
        assert glyph["ch"] == ch
        for key in ("advance", "ascent", "descent"):
            assert isinstance(glyph["metrics"][key], (int, float))
        assert len(glyph["variants"]) >= 1  # -> variantCount(ch)
        for i, variant in enumerate(glyph["variants"]):
            assert variant["index"] == i
            assert variant["contours"], f"{ch!r} variant {i} has no contours"
            for contour in variant["contours"]:
                assert isinstance(contour["outer"], bool)
                assert len(contour["points"]) >= 3
                assert all(len(p) == 2 for p in contour["points"])


def test_every_repeat_becomes_a_variant(tmp_path, monkeypatch) -> None:
    """Four photographed repeats must become four selectable variants, or the RNG has
    nothing to choose between and every `e` on the page is identical."""
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    photos = [
        synth.encode_png(synth.photograph(synth.render_filled_page(p, jitter=0.04)[0], scale=0.55))
        for p in range(3)
    ]
    built = pipeline.extract(photos, "variants").profile
    counts = {ch: len(g["variants"]) for ch, g in built["glyphs"].items()}
    assert max(counts.values()) == 3
    assert sum(1 for n in counts.values() if n == 3) > 0.9 * len(counts)


def test_an_incomplete_sheet_is_marked_incomplete_and_lists_what_failed(
    tmp_path, monkeypatch
) -> None:
    """Under-coverage is reported, never papered over."""
    monkeypatch.setenv("AH_PROFILE_HOME", str(tmp_path))
    # Written count must land BELOW the 60% coverage floor, derived from the
    # charset size rather than a number that silently stops meaning 56%.
    written = int(len(CHARSET) * 0.5)
    skipped = set(CHARSET[written:])
    image, _truth = synth.render_filled_page(0, skip=skipped)
    bgr = synth.photograph(image, scale=0.55)

    result = pipeline.extract([synth.encode_png(bgr)], "partial")

    assert result.profile["status"] == "incomplete"
    assert set(result.profile["coverage"]["missing"]) == skipped
    assert result.profile["failedCells"], "the failed cells must be listed by name"
    assert {f["reason"] for f in result.profile["failedCells"]} <= {
        "empty", "speck", "flooded", "touches-edge", "no-contour",
    }

    warning = pipeline.viability_warning(result)
    assert warning is not None and "incomplete" in warning
