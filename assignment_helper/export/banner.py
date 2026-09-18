"""Startup-banner lines for the export bypasses. Invariant I15.

Every active bypass is printed at launch and badged in the UI, so you can never be
unknowingly in one. `--no-artifacts` is an export bypass, so the line that announces it
lives with the export code and the CLI asks for it.

NOTE for the server strand: the banner itself is printed by `assignment_helper/cli.py`,
which does not exist yet on the seam-freeze commit and is not this strand's file. Call
`bypass_banner_lines(config)` from it. Until then the bypass is still visible in
`GET /api/status` (`bypasses.no_artifacts`, already in the frozen app.py) and in
`GET /api/export/health`, so it is never silent — it is just not yet in the banner.
"""

from __future__ import annotations

from typing import Protocol

__all__ = ["bypass_banner_lines"]


class _HasBypasses(Protocol):
    no_artifacts: bool
    dev_build: bool
    dpi: int | None


def bypass_banner_lines(config: _HasBypasses) -> list[str]:
    """The lines the launch banner must print. Empty when nothing is bypassed."""
    lines: list[str] = []
    if config.no_artifacts:
        lines.append(
            "  BYPASS --no-artifacts: export ships the CLEAN render. "
            "No perspective, vignette, edge shadow or tint. The PDF will not look scanned."
        )
    if config.dpi is not None:
        lines.append(
            f"  BYPASS --dpi {config.dpi}: export DPI is forced, overriding the document's style."
        )
    if config.dev_build:
        lines.append(
            "  DEV BUILD: every exported PDF is stamped 'DEV BUILD <sha>' in its "
            "Producer metadata. Check the document properties before submitting."
        )
    return lines
