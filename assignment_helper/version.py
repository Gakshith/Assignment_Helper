"""Version derivation and the dev-build determination.

A build that is not on a clean tag is a DEVELOPMENT BUILD and says so, loudly, in the
startup banner (invariant I15 — you can never be unknowingly in a bypass, and running
an uncommitted tree is the broadest bypass of all).

Derivation order:
  1. `git describe --tags --dirty --always` from the package's source tree.
     * exactly a tag, clean  -> release:  "1.2.0"
     * anything else         -> dev:      "<base>.dev+<sha>[.dirty]"
  2. No `.git` at all (an installed wheel) -> the version baked into the distribution
     metadata, treated as a release build. A wheel is produced by the release process.
  3. `.git` present but git unusable -> DEV build, with the reason carried in `note`.
     An anomaly here must not silently downgrade to "release"; I5 applies to our own
     provenance as much as to a request handler.

This module must never import cv2/skimage/skan/numba/numpy (I17).
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path

DIST_NAME = "assignment-helper"

# A describe output that is EXACTLY a tag: no -<n>-g<sha> suffix and no -dirty.
_EXACT_TAG = re.compile(r"^v?(?P<base>\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)$")
# tag-<commits since>-g<sha>, optionally -dirty
_DESCRIBED = re.compile(
    r"^v?(?P<base>\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)"
    r"-(?P<ahead>\d+)-g(?P<sha>[0-9a-f]+)(?P<dirty>-dirty)?$"
)
# --always fallback when no tag exists anywhere: just a sha, optionally -dirty
_BARE_SHA = re.compile(r"^(?P<sha>[0-9a-f]{7,40})(?P<dirty>-dirty)?$")


@dataclass(frozen=True)
class VersionInfo:
    version: str
    dev_build: bool
    sha: str | None = None
    dirty: bool = False
    #  Why we concluded what we concluded. Printed under --selftest, never guessed at.
    note: str = ""


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def git_describe(root: Path | None = None, *, runner=subprocess.run) -> str | None:
    """Raw `git describe` output, or None when git cannot answer.

    Returning None is a *fact* (there is no git here), not a swallowed error — callers
    distinguish "no .git directory" from "git blew up" and report them differently.
    """
    root = root or _repo_root()
    try:
        proc = runner(
            # --match 'v*' restricts this to RELEASE tags. Without it, any other tag
            # on the commit wins: `known-good-20260918` and `seam-freeze` are both
            # tags this project legitimately uses, and either would make git describe
            # return something no version parser can read. The failure was benign —
            # version.py refuses to guess and reports a dev build with the reason — but
            # the reason it printed was noise rather than information.
            ["git", "describe", "--tags", "--match", "v*", "--dirty", "--always"],
            cwd=str(root),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    out = (proc.stdout or "").strip()
    return out or None


def _metadata_version() -> str:
    try:
        return metadata.version(DIST_NAME)
    except metadata.PackageNotFoundError:
        # Running from a source tree that was never installed. Not fatal, and not
        # silently "0.0.0" either: the caller prints this base in a dev-build string.
        return "0.0.0"


def parse_describe(described: str, fallback_base: str) -> VersionInfo:
    """Pure. The whole rule set, testable without a git repository."""
    # Strip a trailing -dirty BEFORE any tag match. Without this, `v1.0.0-dirty`
    # matches _EXACT_TAG: `-dirty` is absorbed by the optional prerelease group, and an
    # uncommitted tree sitting on a release tag reports as a CLEAN RELEASE BUILD with no
    # banner in the terminal, no badge in the UI and no sha in the PDF Producer field.
    # That is the exact failure the three-place dev-build guard exists to prevent, so
    # the dirty flag is decided first and separately from anything else.
    stripped = described
    dirty_suffix = False
    if stripped.endswith("-dirty"):
        stripped = stripped[: -len("-dirty")]
        dirty_suffix = True

    exact = _EXACT_TAG.match(stripped)
    if exact:
        base = exact.group("base")
        if dirty_suffix:
            return VersionInfo(
                version=f"{base}.dev+dirty",
                dev_build=True,
                dirty=True,
                note=f"on tag {base} but the working tree has uncommitted changes",
            )
        return VersionInfo(version=base, dev_build=False, note="clean tag")

    hit = _DESCRIBED.match(described)
    if hit:
        dirty = bool(hit.group("dirty"))
        sha = hit.group("sha")
        suffix = ".dirty" if dirty else ""
        return VersionInfo(
            version=f"{hit.group('base')}.dev+{sha}{suffix}",
            dev_build=True,
            sha=sha,
            dirty=dirty,
            note=f"{hit.group('ahead')} commit(s) past tag {hit.group('base')}",
        )

    bare = _BARE_SHA.match(described)
    if bare:
        dirty = bool(bare.group("dirty"))
        sha = bare.group("sha")
        suffix = ".dirty" if dirty else ""
        return VersionInfo(
            version=f"{fallback_base}.dev+{sha}{suffix}",
            dev_build=True,
            sha=sha,
            dirty=dirty,
            note="no tag reachable from HEAD",
        )

    # git said something we do not model. Do NOT claim a release build.
    return VersionInfo(
        version=f"{fallback_base}.dev+unknown",
        dev_build=True,
        note=f"unparsed git describe output {described!r}",
    )


def derive_version(root: Path | None = None, *, runner=subprocess.run) -> VersionInfo:
    root = root or _repo_root()
    base = _metadata_version()

    if not (root / ".git").exists():
        # An installed wheel. No git, and none expected.
        return VersionInfo(version=base, dev_build=False, note="installed distribution metadata")

    described = git_describe(root, runner=runner)
    if described is None:
        return VersionInfo(
            version=f"{base}.dev+unknown",
            dev_build=True,
            note="a .git directory is present but `git describe` failed",
        )
    return parse_describe(described, base)
