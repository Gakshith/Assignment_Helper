"""End to end: photos in, `glyphs.json` out.

    load -> rectify -> segment -> outline -> profile

The rule that shapes this module is acceptance row 4: **no profile.json is written on
a hard failure.** So the profile is assembled entirely in memory and written exactly
once, at the end, after every page has been read. There is no incremental write to
abandon halfway and therefore no half-built profile that looks complete.

The hard/soft split:

  * A page that cannot be rectified is HARD. It raises, nothing is written, and the
    error names which markers were found.
  * A cell that cannot be segmented or outlined is SOFT. It is collected as a
    `CellFailure` and the run continues.

I17: every CV import is inside a function body, in the modules this one calls.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from assignment_helper.glyphs import outline as outline_mod
from assignment_helper.glyphs import profile as profile_mod
from assignment_helper.glyphs import rectify, segment
from assignment_helper.glyphs.charset import CHARSET
from assignment_helper.glyphs.errors import CellFailure, SheetTooSparse

#: Below this fraction of expected samples the input is not a filled-in tracing sheet.
#: Distinct from `incomplete`: this is "you photographed the wrong thing".
MIN_SAMPLE_RATIO = 0.10

ProgressFn = Callable[["Progress"], None]


@dataclass(frozen=True)
class Progress:
    """One progress tick. Reported per page, and once at the end."""

    stage: str
    page: int
    pages_total: int
    cells_done: int
    cells_total: int
    elapsed_s: float

    def as_dict(self) -> dict[str, object]:
        return {
            "stage": self.stage,
            "page": self.page,
            "pagesTotal": self.pages_total,
            "cellsDone": self.cells_done,
            "cellsTotal": self.cells_total,
            "elapsedSeconds": round(self.elapsed_s, 3),
        }


@dataclass
class Timings:
    """Wall-clock per stage, so gate G12 is a measurement and not an estimate."""

    load_s: float = 0.0
    rectify_s: float = 0.0
    segment_s: float = 0.0
    outline_s: float = 0.0
    profile_s: float = 0.0

    @property
    def total_s(self) -> float:
        return self.load_s + self.rectify_s + self.segment_s + self.outline_s + self.profile_s

    @property
    def rectify_segment_s(self) -> float:
        """The G12 sub-budget: rectify + segment <= 8 s for the whole sheet."""
        return self.load_s + self.rectify_s + self.segment_s

    def as_dict(self) -> dict[str, float]:
        return {
            "loadSeconds": round(self.load_s, 3),
            "rectifySeconds": round(self.rectify_s, 3),
            "segmentSeconds": round(self.segment_s, 3),
            "outlineSeconds": round(self.outline_s, 3),
            "profileSeconds": round(self.profile_s, 3),
            "rectifyPlusSegmentSeconds": round(self.rectify_segment_s, 3),
            "totalSeconds": round(self.total_s, 3),
        }


@dataclass
class ExtractionResult:
    """Everything one extraction run produced."""

    profile: dict
    outlines: list = field(default_factory=list)
    failures: list[CellFailure] = field(default_factory=list)
    timings: Timings = field(default_factory=Timings)
    pages_read: list[int] = field(default_factory=list)
    written_to: Path | None = None

    @property
    def viable_ratio(self) -> float:
        return float(self.profile["coverage"]["ratio"])

    @property
    def is_complete(self) -> bool:
        return self.profile["status"] == "complete"


def extract(
    sources: Sequence[Path | bytes],
    profile_id: str,
    *,
    charset: list[str] | None = None,
    drop_blue: bool = True,
    write: bool = True,
    on_progress: ProgressFn | None = None,
) -> ExtractionResult:
    """Run the whole pipeline over one photo per page.

    `sources` is one photo per sheet page, in any order — each page is identified by
    its own marker ids, so the user cannot get it wrong by uploading them shuffled.

    Raises on a HARD failure and writes nothing. Returns a result whose profile may be
    `incomplete` on soft failures.
    """
    chars = charset if charset is not None else CHARSET
    timings = Timings()
    all_outlines: list = []
    all_failures: list[CellFailure] = []
    pages_read: list[int] = []
    cells_total = len(chars) * len(sources)
    cells_done = 0
    started = time.perf_counter()

    def report(stage: str, page: int) -> None:
        if on_progress is not None:
            on_progress(
                Progress(
                    stage=stage,
                    page=page,
                    pages_total=len(sources),
                    cells_done=cells_done,
                    cells_total=cells_total,
                    elapsed_s=time.perf_counter() - started,
                )
            )

    for source in sources:
        t0 = time.perf_counter()
        image = rectify.load_image(source)
        t1 = time.perf_counter()
        timings.load_s += t1 - t0

        report("rectify", len(pages_read))
        warped, page = rectify.warp_to_canonical(image)
        t2 = time.perf_counter()
        timings.rectify_s += t2 - t1

        report("segment", page)
        cell_inks, seg_failures = segment.segment_cells(
            warped, page, chars, drop_blue=drop_blue
        )
        t3 = time.perf_counter()
        timings.segment_s += t3 - t2

        report("outline", page)
        outlines, outline_failures = outline_mod.extract_page(cell_inks, drop_blue)
        t4 = time.perf_counter()
        timings.outline_s += t4 - t3

        all_outlines.extend(outlines)
        all_failures.extend(seg_failures)
        all_failures.extend(outline_failures)
        pages_read.append(page)
        cells_done += len(chars)

    expected_samples = len(chars) * max(1, len(sources))
    if len(all_outlines) < MIN_SAMPLE_RATIO * expected_samples:
        # HARD. Nothing is written. Writing a four-glyph profile here and calling it
        # `incomplete` would technically be honest and practically a trap: the user
        # would go on to render a document in a hand that does not exist.
        raise SheetTooSparse(
            f"Only {len(all_outlines)} of {expected_samples} cells contained anything "
            f"that looks like handwriting.",
            detail=(
                "That usually means a blank sheet, the wrong page, or a photo too "
                "dark to threshold. Nothing has been saved."
            ),
        )

    t0 = time.perf_counter()
    built = profile_mod.build_profile(
        profile_id,
        all_outlines,
        all_failures,
        charset=chars,
        drop_blue=drop_blue,
        pages_read=pages_read,
    )
    written_to = profile_mod.write_profile(profile_id, built) if write else None
    timings.profile_s += time.perf_counter() - t0

    result = ExtractionResult(
        profile=built,
        outlines=all_outlines,
        failures=all_failures,
        timings=timings,
        pages_read=pages_read,
        written_to=written_to,
    )
    report("done", pages_read[-1] if pages_read else 0)
    return result


def viability_warning(result: ExtractionResult) -> str | None:
    """The under-60% warning, as a sentence, or None when coverage is fine.

    Returns the message rather than logging it, so the caller decides where it goes —
    a router turns it into a Problem, a test asserts on it, and neither depends on
    having captured stderr.
    """
    ratio = result.viable_ratio
    if ratio >= segment.VIABLE_RATIO_WARN:
        return None
    missing = result.profile["coverage"]["missing"]
    shown = "".join(missing[:40])
    more = f" (+{len(missing) - 40} more)" if len(missing) > 40 else ""
    return (
        f"Only {ratio:.0%} of the characters came out usable, which is below the "
        f"{segment.VIABLE_RATIO_WARN:.0%} the profile needs to be dependable. "
        f"The profile has been marked incomplete. Missing: {shown}{more}"
    )
