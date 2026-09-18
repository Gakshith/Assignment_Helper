"""Build and write `profile/<name>/glyphs.json`.

The file this module writes is the second source `GlyphProfileProvider.load` reads
(the first is the OFL reference font, built by another strand in the browser). Its
shape is therefore fixed by what `GlyphMetricsProvider` and `GlyphOutlineProvider`
need and by nothing else:

    GlyphMetricsProvider          <- glyphs[ch].metrics, glyphs[ch].variants.length,
                                     substitutions
    GlyphOutlineProvider          <- glyphs[ch].variants[i].contours, unitsPerEm

Invariant I9: this file is the user's handwriting. It is written under Application
Support, never into the repo, and nothing here transmits it anywhere.

Invariant I10: the write is atomic — temp file in the same directory, then
`os.replace`. A profile half-written over a good one would leave the user with no
working hand and no obvious way back.

No CV imports in this module at all; it works on plain Python floats handed over by
`outline.py`.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from assignment_helper.glyphs.charset import CHARSET, REPEATS, SUBSTITUTIONS
from assignment_helper.glyphs.errors import CellFailure, ProfileWriteError
from assignment_helper.glyphs.layout import UNITS_PER_EM
from assignment_helper.glyphs.paths import ensure_profile_dir, profile_json_path

#: Bump when the on-disk shape changes in a way a reader must notice. The browser
#: provider refuses a version it does not know rather than guessing at the fields.
SCHEMA_VERSION = 1

#: Coordinates are rounded to this many decimals before serialising. At 1000 units per
#: em, one decimal is a thousandth of an em - far below what anyone can see, and it
#: roughly halves the file.
COORD_DECIMALS = 1


def _round_points(points) -> list[list[float]]:
    return [[round(x, COORD_DECIMALS), round(y, COORD_DECIMALS)] for x, y in points]


def build_profile(
    profile_id: str,
    outlines,
    failures: list[CellFailure],
    *,
    charset: list[str] | None = None,
    drop_blue: bool,
    pages_read: list[int],
) -> dict:
    """Assemble the profile document from every extracted outline.

    Per-character metrics are the MEDIAN across that character's surviving samples,
    not the mean: one sample with a stray descender or a bit of the neighbour's ink
    would drag a mean and would not move a median.
    """
    chars = charset if charset is not None else CHARSET

    by_char: dict[str, list] = {}
    for outline in outlines:
        by_char.setdefault(outline.ch, []).append(outline)

    def median(values: list[float]) -> float:
        ordered = sorted(values)
        n = len(ordered)
        if n == 0:
            return 0.0
        mid = n // 2
        if n % 2:
            return ordered[mid]
        return (ordered[mid - 1] + ordered[mid]) / 2.0

    glyphs: dict[str, dict] = {}
    for ch, samples in sorted(by_char.items()):
        samples = sorted(samples, key=lambda o: o.repeat)
        variants = [
            {
                "index": i,
                "repeat": s.repeat,
                "advance": round(s.advance, COORD_DECIMALS),
                "ascent": round(s.ascent, COORD_DECIMALS),
                "descent": round(s.descent, COORD_DECIMALS),
                "contours": [
                    {"outer": is_outer, "points": _round_points(points)}
                    for is_outer, points in s.contours
                ],
            }
            for i, s in enumerate(samples)
        ]
        glyphs[ch] = {
            "ch": ch,
            "metrics": {
                "advance": round(median([s.advance for s in samples]), COORD_DECIMALS),
                "ascent": round(median([s.ascent for s in samples]), COORD_DECIMALS),
                "descent": round(median([s.descent for s in samples]), COORD_DECIMALS),
            },
            "variants": variants,
        }

    requested = len(chars)
    covered = len(glyphs)
    ratio = covered / requested if requested else 0.0

    # `incomplete` is a first-class state, not a warning printed and forgotten. A
    # profile that covers 70% of the charset is genuinely usable, and layout needs to
    # know which 30% will come back as a substitution or a Problem (I5).
    missing = sorted(set(chars) - set(glyphs))

    return {
        "schemaVersion": SCHEMA_VERSION,
        "profileId": profile_id,
        "unitsPerEm": UNITS_PER_EM,
        "createdAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "source": "traced",
        "status": "complete" if not missing else "incomplete",
        "extraction": {
            "pagesRead": sorted(pages_read),
            "pagesExpected": REPEATS,
            "colourDropEnabled": drop_blue,
            # Recorded on every profile because it is UNVERIFIED on real paper; if
            # extraction turns out to be bad, the first question is whether this was
            # on and whether it ate the ink. See sheet.py and segment.py.
            "colourDropVerifiedOnPaper": False,
        },
        "coverage": {
            "requested": requested,
            "covered": covered,
            "ratio": round(ratio, 4),
            "missing": missing,
            "samplesExpected": requested * REPEATS,
            "samplesRecovered": len(outlines),
        },
        "failedCells": [f.as_dict() for f in failures],
        "substitutions": dict(sorted(SUBSTITUTIONS.items())),
        "glyphs": glyphs,
    }


def write_profile(profile_id: str, profile: dict) -> Path:
    """Write `glyphs.json` atomically. Invariant I10.

    The temp file is created in the DESTINATION directory, not /tmp, because
    `os.replace` is only atomic within a filesystem and Application Support and /tmp
    are not guaranteed to be the same one.
    """
    directory = ensure_profile_dir(profile_id)
    destination = profile_json_path(profile_id)
    payload = json.dumps(profile, ensure_ascii=False, indent=1, sort_keys=False)

    fd, tmp_path = tempfile.mkstemp(dir=str(directory), prefix=".glyphs-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            # The rename is atomic but the CONTENT is not durable until it is on the
            # platter; without this a crash can leave a correctly-named empty file.
            os.fsync(handle.fileno())
        os.replace(tmp_path, destination)
    except OSError as exc:
        Path(tmp_path).unlink(missing_ok=True)
        raise ProfileWriteError(
            f"Could not write the profile {profile_id!r}.",
            detail=f"{destination}: {exc}",
        ) from exc
    except BaseException:
        # Re-raised immediately; this only stops a temp file outliving the failure.
        Path(tmp_path).unlink(missing_ok=True)
        raise
    return destination


def load_profile(profile_id: str) -> dict:
    """Read a profile back, refusing a schema version this build does not know."""
    path = profile_json_path(profile_id)
    if not path.is_file():
        raise ProfileWriteError(
            f"There is no profile named {profile_id!r}.",
            detail=f"Expected {path}. Run the tracing-sheet extraction first.",
        )
    try:
        profile = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProfileWriteError(
            f"The profile {profile_id!r} could not be read.",
            detail=f"{path}: {exc}",
        ) from exc

    version = profile.get("schemaVersion")
    if version != SCHEMA_VERSION:
        raise ProfileWriteError(
            f"The profile {profile_id!r} was written by a different version of "
            f"assignment-helper (schema {version}, this build reads {SCHEMA_VERSION}).",
            detail="Re-run the extraction from your tracing sheet photos.",
        )
    return profile
