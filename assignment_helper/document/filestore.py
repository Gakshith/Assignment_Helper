"""`FileDocumentStore` — the `DocumentStore` implementation that writes to disk.

`document/store.py` is the frozen contract; this is the thing that satisfies it. The
version rules restated once more because they are the whole point:

  * `version` starts at 0 for a freshly opened document and increments by exactly 1 per
    accepted delta. It is a SESSION counter, not a field of the document — one open
    document per server process in v1, and the client resyncs on connect.
  * `Delta.parent_version != version` raises `DeltaRejected`. There is no merge, no
    rebase and no "close enough" (invariant I4). The client asks for a snapshot.

WHERE THE FILE LIVES. Beside the user's source file: `hw7.md` -> `hw7.ah.json`. It is
the user's work, not our cache — it belongs in their Time Machine backup, next to the
thing it was made from, and it is pretty-printed JSON so `git diff` on a homework repo
says something useful.

INVARIANT I10 — ATOMIC PERSISTENCE. Every write is: create a temp file in the SAME
directory (so `os.replace` is a rename within one filesystem and therefore atomic),
write it, fsync it, then `os.replace` it over the destination, then fsync the directory
so the rename itself survives a power cut. At no instant does the destination path hold
a half-written document. A crash yields either the old complete file or the new one.

HISTORY. The last `retain` versions are copied into a hidden sibling directory,
`.<name>.ah.json.history/v000003.json`. A sibling directory rather than five
`hw7.ah.json.N` files next to the homework, because the user has to look at that folder.
It is deliberately NOT the same naming scheme as the migration backups (`.bak-v<n>`,
see document/migrations): those are keyed by SCHEMA version and survive across sessions.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from assignment_helper.document.migrations import (
    DocumentTooNew,
    backup_path_for,
    migrate,
    needs_migration,
)
from assignment_helper.document.ops import OpFailed, apply_ops
from assignment_helper.document.schema import Delta, Document, Problem, Snapshot
from assignment_helper.document.store import DeltaRejected

__all__ = [
    "DEFAULT_RETAIN",
    "DOCUMENT_SUFFIX",
    "DocumentReadError",
    "FileDocumentStore",
    "document_path_for",
    "history_dir_for",
]

log = logging.getLogger(__name__)

DOCUMENT_SUFFIX = ".ah.json"
DEFAULT_RETAIN = 5

# Bound alias so a test can make the rename fail without monkeypatching os globally.
# The crash-mid-write test replaces this and asserts the destination is untouched.
_replace = os.replace


class DocumentReadError(Exception):
    """The .ah.json beside the source file could not be read as a document."""

    def __init__(self, message: str, *, code: str = "document.unreadable") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------ paths


def document_path_for(source_path: Path | str) -> Path:
    """`/w/hw7.md` -> `/w/hw7.ah.json`. Beside the source, never in a cache dir."""
    path = Path(source_path)
    if path.name.endswith(DOCUMENT_SUFFIX):
        return path
    return path.with_name(path.stem + DOCUMENT_SUFFIX)


def history_dir_for(document_path: Path | str) -> Path:
    path = Path(document_path)
    return path.with_name(f".{path.name}.history")


# ------------------------------------------------------------------ atomic write


def _fsync_dir(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_write_text(path: Path, data: str) -> None:
    """Invariant I10. Temp file in the same directory, fsync, then rename."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f"{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        _replace(tmp, path)
    except BaseException:
        # Not a swallowed failure: the original exception is re-raised immediately.
        # This only stops a crashed write from leaving litter beside the homework.
        tmp.unlink(missing_ok=True)
        raise
    _fsync_dir(path.parent)


def _encode(document: Document) -> str:
    # indent=2 and a trailing newline: this file goes in the user's git repo.
    return document.model_dump_json(indent=2) + "\n"


# ------------------------------------------------------------------ the store


class FileDocumentStore:
    """Satisfies the frozen `DocumentStore` Protocol."""

    def __init__(
        self,
        path: Path | str,
        document: Document,
        *,
        retain: int = DEFAULT_RETAIN,
    ) -> None:
        self._path = Path(path)
        self._document = document
        self._version = 0
        self._retain = retain
        self._handlers: list[Callable[[Snapshot, str], None]] = []
        self._problems: list[Problem] = []

    # -------------------------------------------------------------- open/create

    @classmethod
    def create(
        cls,
        path: Path | str,
        document: Document,
        *,
        retain: int = DEFAULT_RETAIN,
    ) -> FileDocumentStore:
        """Start a new document at version 0 and write it to disk immediately."""
        store = cls(path, document, retain=retain)
        store._persist(document, 0)
        return store

    @classmethod
    def open(
        cls,
        path: Path | str,
        *,
        retain: int = DEFAULT_RETAIN,
    ) -> FileDocumentStore:
        """Read an existing `.ah.json`, migrating it forward if it is older.

        Raises `DocumentTooNew` (with a message naming the `.bak-v<n>` file and the
        command to restore it) when the file came from a newer build, and
        `DocumentReadError` when it is not decodable.
        """
        document_path = Path(path)
        try:
            text = document_path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise DocumentReadError(
                f"There is no document at {document_path}. Open the source file instead "
                "and one will be created beside it.",
                code="document.missing",
            ) from exc
        except OSError as exc:
            raise DocumentReadError(
                f"Could not read {document_path}: {exc.strerror or exc}.",
                code="document.unreadable",
            ) from exc

        try:
            raw: Any = json.loads(text)
        except json.JSONDecodeError as exc:
            raise DocumentReadError(
                f"{document_path} is not valid JSON (line {exc.lineno}, column "
                f"{exc.colno}: {exc.msg}). If you have a copy in "
                f"{history_dir_for(document_path)}, copy it back over this file.",
                code="document.corrupt-json",
            ) from exc

        if not isinstance(raw, dict):
            raise DocumentReadError(
                f"{document_path} contains a JSON {type(raw).__name__}, not an object, "
                "so it is not an assignment-helper document.",
                code="document.not-a-document",
            )

        # DocumentTooNew carries the recovery instructions; let it out unchanged.
        upgraded = needs_migration(raw)
        if upgraded:
            original_version = raw["schema_version"]
            backup = backup_path_for(document_path, original_version)
            _atomic_write_text(backup, text)
            log.info("wrote pre-migration backup %s", backup)
        migrated = migrate(raw, document_path=document_path)

        try:
            document = Document.model_validate(migrated)
        except Exception as exc:  # pydantic ValidationError and anything it wraps
            raise DocumentReadError(
                f"{document_path} does not match this build's document schema: {exc}",
                code="document.invalid",
            ) from exc

        store = cls(document_path, document, retain=retain)
        if upgraded:
            store._persist(document, 0)
        return store

    @classmethod
    def for_source(
        cls,
        source_path: Path | str,
        document: Document,
        *,
        retain: int = DEFAULT_RETAIN,
    ) -> FileDocumentStore:
        """Open `<source>.ah.json` if it exists, otherwise create it from `document`."""
        target = document_path_for(source_path)
        if target.exists():
            return cls.open(target, retain=retain)
        return cls.create(target, document, retain=retain)

    # -------------------------------------------------------------- protocol

    @property
    def version(self) -> int:
        return self._version

    @property
    def path(self) -> Path:
        return self._path

    @property
    def problems(self) -> list[Problem]:
        """Non-fatal faults the store has seen — a subscriber that raised, a history
        file it could not prune. Visible, never swallowed (invariant I5)."""
        return list(self._problems)

    def snapshot(self) -> Snapshot:
        return Snapshot(version=self._version, document=self._document)

    def apply(self, delta: Delta) -> Snapshot:
        if delta.parent_version != self._version:
            raise DeltaRejected(delta.parent_version, self._version)

        # apply_ops raises OpFailed before anything is committed, so a bad op sequence
        # leaves both the in-memory document and the file exactly as they were.
        new_document = apply_ops(self._document, delta.ops)
        new_version = self._version + 1
        self._persist(new_document, new_version)
        self._document = new_document
        self._version = new_version

        snapshot = self.snapshot()
        self._emit(snapshot, delta.origin)
        return snapshot

    def replace(self, doc: Document, origin: str) -> Snapshot:
        new_version = self._version + 1
        self._persist(doc, new_version)
        self._document = doc
        self._version = new_version

        snapshot = self.snapshot()
        self._emit(snapshot, origin)
        return snapshot

    def subscribe(self, handler: Callable[[Snapshot, str], None]) -> None:
        self._handlers.append(handler)

    # -------------------------------------------------------------- internals

    def _emit(self, snapshot: Snapshot, origin: str) -> None:
        """Fan out to every subscriber.

        One handler raising must not corrupt the store, must not stop the others, and
        must NOT be swallowed. It is logged at exception level with a stack trace and
        recorded as a `Problem` so it is visible in-process too (invariant I5). The
        change itself has already been accepted and written; refusing it now would be a
        lie, because the document on disk has moved on.
        """
        for handler in list(self._handlers):
            try:
                handler(snapshot, origin)
            except Exception:
                name = getattr(handler, "__qualname__", repr(handler))
                log.exception(
                    "document subscriber %s raised while handling version %d "
                    "(origin=%s). The change is already committed; this subscriber "
                    "missed it and may now be showing a stale document.",
                    name,
                    snapshot.version,
                    origin,
                )
                self._problems.append(
                    Problem(
                        scope="app",
                        code="document.subscriber-failed",
                        message=(
                            f"A document subscriber ({name}) failed on version "
                            f"{snapshot.version}. Its view of the document may be stale; "
                            "reload the page to resync."
                        ),
                    )
                )

    def _persist(self, document: Document, version: int) -> None:
        payload = _encode(document)
        if self._retain > 0:
            # History first: if this fails we raise before the live file moves, so the
            # caller sees a real error and the store is still consistent.
            _atomic_write_text(self._history_path(version), payload)
            self._prune_history()
        _atomic_write_text(self._path, payload)

    def _history_path(self, version: int) -> Path:
        return history_dir_for(self._path) / f"v{version:06d}.json"

    def _prune_history(self) -> None:
        directory = history_dir_for(self._path)
        if not directory.is_dir():
            return
        kept = sorted(directory.glob("v*.json"))
        for stale in kept[: max(0, len(kept) - self._retain)]:
            try:
                stale.unlink()
            except OSError as exc:
                # Benign — an undeletable old snapshot must not block the user's edit.
                # Logged and surfaced, never silent.
                log.warning("could not prune old document version %s: %s", stale, exc)
                self._problems.append(
                    Problem(
                        scope="app",
                        code="document.history-prune-failed",
                        message=(
                            f"Could not delete the old version file {stale}: {exc}. "
                            "Your document is saved; only cleanup failed."
                        ),
                    )
                )


# Re-exported so callers importing the store do not also have to import migrations.
__all__ += ["DeltaRejected", "DocumentTooNew", "OpFailed"]
