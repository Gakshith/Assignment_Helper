"""Where profiles live. Invariant I9: never inside the repo, never transmitted.

The repo is public. The tracing sheet, the extracted profile and any font built from
it are the user's handwriting, and handwriting is biometric-adjacent: it is the thing
on their signature. So profiles live under Application Support, outside any git
working tree, and nothing here ever writes into the package directory.

`AH_PROFILE_HOME` overrides the root. That exists for tests — which must never touch
the real profile directory — and for a user who keeps their home directory synced to
a cloud drive and would rather this did not follow.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

from assignment_helper.glyphs.errors import ProfileWriteError

#: Conservative: what survives a filename on every filesystem, with no dots or spaces
#: so a profile id can never walk up a path or collide with an extension.
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def profile_home() -> Path:
    """The root directory holding every profile."""
    override = os.environ.get("AH_PROFILE_HOME")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "assignment-helper"
    if sys.platform == "win32":
        base = os.environ.get("APPDATA")
        root = Path(base) if base else Path.home() / "AppData" / "Roaming"
        return root / "assignment-helper"
    base = os.environ.get("XDG_DATA_HOME")
    root = Path(base) if base else Path.home() / ".local" / "share"
    return root / "assignment-helper"


def validate_profile_id(profile_id: str) -> str:
    """Reject anything that is not a plain identifier, loudly.

    `HandStyle.profile` is a free string that reaches this function and then reaches
    the filesystem. It is checked here rather than trusted, so "../../.ssh" is a named
    error and not a path traversal.
    """
    if not _SAFE_ID.match(profile_id):
        raise ProfileWriteError(
            f"{profile_id!r} is not a usable profile name.",
            detail=(
                "Use 1-64 letters, digits, dashes or underscores, starting with a "
                "letter or digit. No dots, slashes or spaces."
            ),
        )
    return profile_id


def profile_dir(profile_id: str) -> Path:
    """The directory for one profile. Not created; see `ensure_profile_dir`."""
    return profile_home() / "profiles" / validate_profile_id(profile_id)


def profile_json_path(profile_id: str) -> Path:
    return profile_dir(profile_id) / "glyphs.json"


def ensure_profile_dir(profile_id: str) -> Path:
    """Create the profile directory, or say why it could not be created."""
    target = profile_dir(profile_id)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ProfileWriteError(
            f"Could not create the profile directory for {profile_id!r}.",
            detail=f"{target}: {exc}",
        ) from exc
    return target


def list_profiles() -> list[str]:
    """Every profile id already on disk, sorted. Empty when none exist yet."""
    root = profile_home() / "profiles"
    if not root.is_dir():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "glyphs.json").is_file())
