"""Forward-only document migrations.

Shape, fixed now so it does not have to be invented under pressure later:

  * one function per step, `v(n) -> v(n+1)`, registered in `MIGRATIONS[n]`;
  * each step takes and returns a plain `dict` (the JSON), never a pydantic model —
    a model of the OLD schema does not exist in this build, so it cannot be parsed;
  * a committed golden fixture per version under `tests/fixtures/documents/`, so a
    step is tested against the bytes a real old build wrote, not against a dict a test
    made up today;
  * migrations run on open, in order, and the upgraded document is written back.

BEFORE the first upgrading step runs, the original bytes are copied to
`<name>.ah.json.bak-v<n>` where n is the schema version they were written at.

REFUSING A DOCUMENT FROM THE FUTURE is the other half of that, and the half that is
usually missing. If the user upgrades, opens a document (which migrates it and leaves a
`.bak-v<n>`), then downgrades — reinstalls the old build, or checks out an older tag —
the old build sees a `schema_version` it does not understand. It must not guess, and it
must not fail with a stack trace either: it has to name the backup file it left behind
and the command that puts it back. A backup that is written and never mentioned locks
the user out of their own homework.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from assignment_helper.document.schema import SCHEMA_VERSION

__all__ = [
    "MIGRATIONS",
    "DocumentTooNew",
    "MigrationFailed",
    "backup_path_for",
    "find_backup",
    "migrate",
    "needs_migration",
]

Migration = Callable[[dict[str, Any]], dict[str, Any]]

_BAK_RE = re.compile(r"\.bak-v(\d+)$")


class MigrationFailed(Exception):
    """A document could not be brought up to the current schema version."""

    def __init__(self, message: str, *, code: str = "document.migration-failed") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class DocumentTooNew(Exception):
    """The document was written by a newer build. Refuse, and say how to recover."""

    code = "document.schema-too-new"

    def __init__(
        self,
        found_version: int,
        supported_version: int,
        *,
        document_path: Path | None = None,
        backup_path: Path | None = None,
        message: str | None = None,
    ) -> None:
        self.found_version = found_version
        self.supported_version = supported_version
        self.document_path = document_path
        self.backup_path = backup_path
        self.message = message or _too_new_message(document_path, found_version, supported_version)
        super().__init__(self.message)


# ------------------------------------------------------------------ backups


def backup_path_for(document_path: Path | str, schema_version: int) -> Path:
    """`hw7.ah.json` at schema v0 -> `hw7.ah.json.bak-v0`, beside the original."""
    path = Path(document_path)
    return path.with_name(f"{path.name}.bak-v{schema_version}")


def find_backup(document_path: Path | str) -> Path | None:
    """The highest-numbered `.bak-v<n>` sitting beside `document_path`, if any."""
    path = Path(document_path)
    parent = path.parent if str(path.parent) else Path(".")
    if not parent.is_dir():
        return None
    best: tuple[int, Path] | None = None
    for candidate in parent.glob(f"{path.name}.bak-v*"):
        match = _BAK_RE.search(candidate.name)
        if match is None:
            continue
        version = int(match.group(1))
        if best is None or version > best[0]:
            best = (version, candidate)
    return None if best is None else best[1]


def _too_new_message(document_path: Path | None, found: int, supported: int) -> str:
    name = document_path.name if document_path is not None else "This document"
    lines = [
        (f"{name} was written by a NEWER build of assignment-helper "
        f"(schema_version {found}; this build understands {supported})."),
        ("It was not opened. Migrations only run forwards, so opening it here would "
        "either lose fields this build does not know about or corrupt the file."),
        "",
    ]
    backup = find_backup(document_path) if document_path is not None else None
    if backup is not None:
        lines += [
            "A copy from before the upgrade is sitting right next to it:",
            f"    {backup}",
            "",
            "Restore it with:",
            f'    cp "{backup}" "{document_path}"',
            "",
        ]
    elif document_path is not None:
        expected = backup_path_for(document_path, supported)
        lines += [
            "No pre-upgrade backup was found beside it. If one existed it would be at:",
            f"    {expected}",
            "",
        ]
    lines.append(
        "Otherwise install a build of assignment-helper that understands "
        f"schema_version {found} and open it there."
    )
    return "\n".join(lines)


# ------------------------------------------------------------------ steps


def _v0_to_v1(raw: dict[str, Any]) -> dict[str, Any]:
    """v0 -> v1: identity.

    v0 is the pre-release shape and it is field-for-field identical to v1; the version
    was stamped so that the machinery, the fixtures and the refusal path all exist and
    are tested before a real migration has to be written in a hurry. The only change is
    the stamp itself.
    """
    return {**raw, "schema_version": 1}


MIGRATIONS: dict[int, Migration] = {
    0: _v0_to_v1,
}


# ------------------------------------------------------------------ driver


def _read_version(raw: dict[str, Any]) -> int:
    if "schema_version" not in raw:
        raise MigrationFailed(
            "This file has no `schema_version` field, so it is not an assignment-helper "
            "document. Point --open at the .ah.json written beside your source file.",
            code="document.not-a-document",
        )
    version = raw["schema_version"]
    if not isinstance(version, int) or isinstance(version, bool):
        raise MigrationFailed(
            f"`schema_version` is {version!r}, which is not an integer. The file is "
            "corrupt or was not written by assignment-helper.",
            code="document.not-a-document",
        )
    return version


def needs_migration(raw: dict[str, Any]) -> bool:
    return _read_version(raw) < SCHEMA_VERSION


def migrate(raw: dict[str, Any], *, document_path: Path | str | None = None) -> dict[str, Any]:
    """Bring a decoded document up to `SCHEMA_VERSION`.

    Raises `DocumentTooNew` if it came from a newer build, `MigrationFailed` if a step
    is missing or misbehaves. Never returns a partially migrated document.
    """
    path = Path(document_path) if document_path is not None else None
    version = _read_version(raw)

    if version > SCHEMA_VERSION:
        raise DocumentTooNew(version, SCHEMA_VERSION, document_path=path)

    current = dict(raw)
    while version < SCHEMA_VERSION:
        step = MIGRATIONS.get(version)
        if step is None:
            raise MigrationFailed(
                f"No migration is registered from schema_version {version} to "
                f"{version + 1}, so this document cannot be brought up to "
                f"{SCHEMA_VERSION}. This is a bug in assignment-helper, not in your "
                "file; please report the version number above."
            )
        current = step(current)
        produced = _read_version(current)
        if produced != version + 1:
            raise MigrationFailed(
                f"The migration from schema_version {version} produced a document "
                f"stamped {produced}, not {version + 1}. Refusing to continue rather "
                "than loop or write a mislabelled file."
            )
        version = produced

    return current
