"""The document store contract. ***FROZEN.*** Second Python convergence point.

The server document is authoritative (invariant I4). This is the interface the server
strand codes against and the document strand implements, declared here so neither has
to guess and neither has to edit the other's files.

Version semantics, stated once:
  * `version` starts at 0 and increments by exactly 1 per accepted delta.
  * A delta whose `parent_version` != the current version is REJECTED. Never merged
    blindly, never reconciled heuristically — the client asks for a snapshot instead.
  * Persistence is temp-file + os.replace, always (invariant I10). A crash mid-write
    never yields a truncated document.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from assignment_helper.document.schema import Delta, Document, Snapshot


class DeltaRejected(Exception):
    """Raised when parent_version does not match. Carries both versions so the server
    can tell the client exactly what to resync to, rather than a bare 409."""

    def __init__(self, parent_version: int, current_version: int) -> None:
        super().__init__(
            f"delta parent_version {parent_version} != current version {current_version}"
        )
        self.parent_version = parent_version
        self.current_version = current_version


@runtime_checkable
class DocumentStore(Protocol):
    """One open document per server process in v1."""

    @property
    def version(self) -> int: ...

    def snapshot(self) -> Snapshot: ...

    def apply(self, delta: Delta) -> Snapshot:
        """Apply a delta and return the new snapshot.

        Raises DeltaRejected when parent_version does not match. Must be atomic: a
        delta that fails partway leaves the document exactly as it was.
        """
        ...

    def replace(self, doc: Document, origin: str) -> Snapshot:
        """Wholesale replacement — a reload from disk, or an ingest result.
        Bumps the version like any other change so clients resync normally."""
        ...

    def subscribe(self, handler) -> None:
        """Register handler(snapshot, origin) called after every accepted change.
        The WS endpoint uses this to fan out to connected clients."""
        ...
