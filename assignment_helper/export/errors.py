"""Typed export failures. Invariant I5: every failure names what failed and what to do.

There is no bare `raise` and no `except: pass` anywhere in this package. Each error
carries a stable `code` that the client turns into a Problem, and a `message` written
for the person sitting in front of the machine, not for a log grepper.
"""

from __future__ import annotations


class ExportError(Exception):
    """Base of every named export failure."""

    code = "export.failed"

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


class ExportDiskError(ExportError):
    """Acceptance row 14. The disk filled, or a write was refused by the filesystem.

    Everything this export wrote is removed before the error escapes: the partial PDF
    and every spooled page. The temp directory is empty afterwards.
    """

    code = "export.disk-full"


class ExportAborted(ExportError):
    """The export was cancelled — by the user, by the tab closing (row 13), by a
    sleep/wake (row 11) or by a per-page timeout (I6). Never resumed from a half state."""

    code = "export.aborted"


class ExportBlocked(ExportError):
    """Plan §C.5.4. A block carries a problem badge, so export is refused outright
    rather than choosing between printing a red badge and hiding the warning."""

    code = "export.blocked-by-problem"


class ExportProtocolError(ExportError):
    """The client sent something the pipeline cannot act on — a wrong-sized page
    buffer, an unknown session, a page index out of range."""

    code = "export.protocol"


class ExportDestinationError(ExportError):
    """The PDF cannot be written where it was asked to go."""

    code = "export.destination"
