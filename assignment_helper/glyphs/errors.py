"""Typed glyph-extraction failures. Invariant I5: every failure names what failed.

There is no bare `raise`, no `except: pass` and no `|| default` anywhere in this
package. Each error carries a stable `code` the client turns into a Problem, and a
message written for the person holding the sheet, not for a log grepper.

The hard/soft split matters and is load-bearing:

  * A HARD failure (`GlyphExtractionError`) aborts the run and **no profile.json is
    written**. Acceptance row 4 turns on this: a half-built profile presented as
    complete is worse than no profile.
  * A SOFT failure is a per-cell `CellFailure` record. It never raises; it is
    collected, reported, and marks the profile `incomplete`.

This module imports nothing from the CV stack, at module scope or otherwise, so the
router can name these codes without dragging cv2 anywhere near the serve path (I17).
"""

from __future__ import annotations

from dataclasses import dataclass


class GlyphExtractionError(Exception):
    """Base of every named HARD extraction failure. No profile is written."""

    code = "glyphs.failed"

    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail

    def as_problem(self) -> dict[str, object]:
        """The wire shape the client raises into the kernel's ProblemSink."""
        return {
            "scope": "app",
            "code": self.code,
            "message": self.message,
            "detail": self.detail,
        }


class MarkersNotFound(GlyphExtractionError):
    """Acceptance row 4. Fewer than four ArUco corner markers were located.

    `found` lists the marker ids that WERE seen, because "could not find 4 corner
    markers" alone does not tell the user whether they cropped the top of the sheet
    off or photographed it too dark to detect anything at all.
    """

    code = "glyphs.markers-not-found"

    def __init__(
        self,
        message: str,
        *,
        found: list[int] | None = None,
        expected: list[int] | None = None,
        detail: str | None = None,
    ) -> None:
        super().__init__(message, detail=detail)
        self.found = sorted(found or [])
        self.expected = sorted(expected or [])

    def as_problem(self) -> dict[str, object]:
        problem = super().as_problem()
        problem["found"] = self.found
        problem["expected"] = self.expected
        problem["missing"] = [m for m in self.expected if m not in self.found]
        return problem


class SheetUnreadable(GlyphExtractionError):
    """The image decoded but cannot be used — empty, wrong number of channels, or so
    small that a cell would be a handful of pixels."""

    code = "glyphs.sheet-unreadable"


class SheetTooSparse(GlyphExtractionError):
    """So few cells yielded ink that this is not a filled-in tracing sheet at all.

    Distinct from `incomplete`: below this floor the most likely truth is that the
    user photographed a blank sheet or the wrong page, and silently writing a profile
    with four glyphs in it would be a lie.
    """

    code = "glyphs.sheet-too-sparse"


class ProfileWriteError(GlyphExtractionError):
    """The profile directory cannot be created or written."""

    code = "glyphs.profile-write"


@dataclass(frozen=True)
class CellFailure:
    """A SOFT, per-cell failure. Collected and reported; never raised.

    `reason` is one of a small closed set so the UI can group them rather than
    showing 40 lines of prose:
      empty        - no ink found in the cell
      speck        - ink found but far too little to be a glyph
      flooded      - ink covers most of the cell (a smudge, a shadow, a scribble-out)
      touches-edge - the component runs off the padded crop, so it is truncated
      no-contour   - a mask survived but produced no usable closed contour
    """

    ch: str
    repeat: int
    page: int
    reason: str
    detail: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "ch": self.ch,
            "repeat": self.repeat,
            "page": self.page,
            "reason": self.reason,
            "detail": self.detail,
        }
