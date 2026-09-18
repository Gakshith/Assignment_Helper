"""Watching the source file on disk. STDLIB ONLY.

`watchfiles` was dropped deliberately: no cp314 wheel, so it falls back to compiling a
Rust toolchain at install time. Plan §C.4's fallback doctrine says drop the dependency
rather than move the Python pin, and the job here does not justify one — an mtime+size
poll of a SINGLE file at ~1 Hz on a background thread is the whole requirement. Do not
reintroduce a watcher dependency for this.

Acceptance row 16, and it is the important half:

    NEVER AUTO-CLOBBER AN EDITED DOCUMENT.

If the in-app document has unsaved divergence from disk, an external change raises a
banner offering Reload / Keep mine and touches nothing. Only with no in-app changes
does it reload silently. The decision lives in DocumentFileCoordinator, away from the
polling, so both halves are testable without a filesystem or a thread.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from assignment_helper.document.schema import Document, Snapshot

POLL_INTERVAL_S = 1.0

Signature = tuple[int, int] | None  # (st_mtime_ns, st_size), or None when absent


class _StoreLike(Protocol):
    @property
    def version(self) -> int: ...
    def snapshot(self) -> Snapshot: ...
    def replace(self, doc: Document, origin: str) -> Snapshot: ...


def signature_of(path: Path, *, stat: Callable[[str], os.stat_result] = os.stat) -> Signature:
    """mtime_ns + size. Size is carried because a fast rewrite can land inside the same
    mtime tick on some filesystems, and a same-mtime different-size file is a change."""
    try:
        st = stat(str(path))
    except (OSError, ValueError):
        return None
    return (st.st_mtime_ns, st.st_size)


class FileWatcher:
    """One file, one thread, one poll. Nothing clever."""

    def __init__(
        self,
        path: Path,
        on_change: Callable[[Path], None],
        *,
        on_error: Callable[[BaseException], None],
        interval_s: float = POLL_INTERVAL_S,
        stat: Callable[[str], os.stat_result] = os.stat,
    ) -> None:
        self.path = Path(path)
        self._on_change = on_change
        self._on_error = on_error
        self._interval = interval_s
        self._stat = stat
        self._signature: Signature = signature_of(self.path, stat=stat)
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()

    @property
    def signature(self) -> Signature:
        return self._signature

    def rearm(self) -> None:
        """Adopt the current on-disk state as the new baseline without firing."""
        self._signature = signature_of(self.path, stat=self._stat)

    def poll_once(self) -> bool:
        """Returns True when a change was seen (and on_change was called)."""
        current = signature_of(self.path, stat=self._stat)
        if current == self._signature:
            return False
        self._signature = current
        self._on_change(self.path)
        return True

    # ------------------------------------------------------------ thread

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name=f"ah-watch:{self.path.name}", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None:
            thread.join(timeout=timeout)

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                self.poll_once()
            except Exception as exc:
                # I5: an exception in a daemon thread kills the thread in total silence
                # and the watcher just stops working. Route it out and keep polling.
                self._on_error(exc)


# ---------------------------------------------------------------- row 16


@dataclass(frozen=True)
class DiskChange:
    """What the coordinator decided to do about an external edit."""

    outcome: str  # "reloaded" | "conflict" | "vanished"
    version: int
    message: str


class DocumentFileCoordinator:
    """Decides what an external change to the source file means. Row 16.

    Dirtiness is measured against the store's own version counter rather than a diff:
    the store bumps the version by exactly 1 per accepted change (store.py), so
    `store.version != synced_version` is precisely "the app changed the document since
    we last agreed with disk". No heuristics, no content comparison.
    """

    def __init__(
        self,
        path: Path,
        store: _StoreLike,
        loader: Callable[[Path], Document],
        notify: Callable[[dict[str, Any]], None],
    ) -> None:
        self.path = Path(path)
        self._store = store
        self._loader = loader
        self._notify = notify
        self._synced_version = store.version
        self._pending_conflict = False

    @property
    def dirty(self) -> bool:
        return self._store.version != self._synced_version

    @property
    def pending_conflict(self) -> bool:
        return self._pending_conflict

    def mark_synced(self) -> None:
        self._synced_version = self._store.version
        self._pending_conflict = False

    def status(self) -> dict[str, Any]:
        return {
            "path": str(self.path),
            "dirty": self.dirty,
            "pending_conflict": self._pending_conflict,
            "version": self._store.version,
            "synced_version": self._synced_version,
        }

    # ------------------------------------------------------------ the decision

    def on_disk_change(self) -> DiskChange:
        if not self.path.exists():
            self._pending_conflict = True
            message = (
                f"{self.path.name} disappeared from disk. The in-app document is "
                "untouched; save it somewhere before closing this tab."
            )
            self._notify(
                {
                    "type": "file.vanished",
                    "problem": {
                        "scope": "app",
                        "code": "file.vanished",
                        "message": message,
                        "detail": str(self.path),
                    },
                }
            )
            return DiskChange("vanished", self._store.version, message)

        if self.dirty:
            # THE WHOLE POINT OF ROW 16. The store is not touched. Not read, not
            # replaced, not merged. The user decides.
            self._pending_conflict = True
            message = (
                f"{self.path.name} changed on disk, and you have unsaved changes here. "
                "Reload from disk, or keep yours?"
            )
            self._notify(
                {
                    "type": "file.conflict",
                    "path": str(self.path),
                    "actions": ["reload", "keep-mine"],
                    "problem": {
                        "scope": "app",
                        "code": "file.conflict",
                        "message": message,
                        "detail": str(self.path),
                    },
                }
            )
            return DiskChange("conflict", self._store.version, message)

        # No in-app changes: adopting disk loses nothing, so do it silently.
        snap = self._replace_from_disk()
        message = f"{self.path.name} changed on disk and was reloaded."
        self._notify(
            {
                "type": "file.reloaded",
                "path": str(self.path),
                "version": snap.version,
                "message": message,
            }
        )
        return DiskChange("reloaded", snap.version, message)

    # ------------------------------------------------------------ user's choice

    def reload_from_disk(self) -> Snapshot:
        """The user clicked Reload. Clobbering is now consented to."""
        snap = self._replace_from_disk()
        self._notify(
            {
                "type": "file.reloaded",
                "path": str(self.path),
                "version": snap.version,
                "message": f"Reloaded {self.path.name} from disk.",
            }
        )
        return snap

    def keep_mine(self) -> Snapshot:
        """The user clicked Keep mine. The in-app document wins and stays dirty.

        The disk baseline is NOT adopted as synced: the document still differs from the
        file, and the next external change must prompt again.
        """
        self._pending_conflict = False
        snap = self._store.snapshot()
        self._notify(
            {
                "type": "file.kept-mine",
                "path": str(self.path),
                "version": snap.version,
                "message": f"Kept the in-app document; {self.path.name} on disk was ignored.",
            }
        )
        return snap

    def _replace_from_disk(self) -> Snapshot:
        doc = self._loader(self.path)
        snap = self._store.replace(doc, origin="file")
        self._synced_version = snap.version
        self._pending_conflict = False
        return snap


def now_s() -> float:
    return time.monotonic()
