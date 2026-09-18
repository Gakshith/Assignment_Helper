"""Export: spool raw RGBA pages, run the artifact pass, assemble the PDF.

The browser is the only renderer (see CLAUDE.md). Python never draws ink — it receives
pixels that the Worker already painted from the geometry at export DPI, ages them, and
binds them into a PDF.

Invariant I11: export never reads the screen. The Worker re-PAINTS the same geometry at
export DPI; it does not upscale a preview bitmap, and it does not re-run layout. Re-running
layout at export DPI would re-create exactly the preview/export divergence that gate G16
exists to catch.

I17: this package may not import cv2, skimage, skan, numba or numpy at all — not even
inside a function body. That allowance is for `assignment_helper/glyphs/**`. The artifact
pass is Pillow-only and an import-linter contract in pyproject.toml enforces it.
"""

from __future__ import annotations

from assignment_helper.export.artifacts import ArtifactParams, apply_artifacts
from assignment_helper.export.banner import bypass_banner_lines
from assignment_helper.export.errors import (
    ExportAborted,
    ExportBlocked,
    ExportDestinationError,
    ExportDiskError,
    ExportError,
    ExportProtocolError,
)
from assignment_helper.export.pdf import BuildStamp, build_stamp
from assignment_helper.export.pipeline import ExportResult, ExportSession, ExportSessions

__all__ = [
    "ArtifactParams",
    "BuildStamp",
    "ExportAborted",
    "ExportBlocked",
    "ExportDestinationError",
    "ExportDiskError",
    "ExportError",
    "ExportProtocolError",
    "ExportResult",
    "ExportSession",
    "ExportSessions",
    "apply_artifacts",
    "build_stamp",
    "bypass_banner_lines",
]
