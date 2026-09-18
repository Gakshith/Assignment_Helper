"""Pillow JPEG -> img2pdf -> a PDF beside the document, then reveal it.

The encode settings are fixed by plan §C.5: JPEG quality 80, subsampling 2, dpi
(200, 200). They are not tuning knobs. img2pdf reads the DPI out of the JPEG and sizes
the PDF page from it, which is the only reason the physical page comes out at exactly
8.5 x 11 in rather than "whatever 1700 px happens to mean".

G10 (<=700 KB/page) is a WARNING, not a gate. Procedural paper grain is high-entropy by
construction and defeats every compression predictor, so G10 and believability pull in
opposite directions on the same knob. A G10 warning is never fixed by degrading the
render.

I17: Pillow and img2pdf only. No numpy, not even lazily.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import img2pdf
from PIL import Image

from assignment_helper.export.errors import ExportDestinationError, ExportDiskError

__all__ = [
    "JPEG_QUALITY",
    "JPEG_SUBSAMPLING",
    "PAGE_SIZE_WARN_BYTES",
    "BuildStamp",
    "build_stamp",
    "encode_jpeg",
    "resolve_output_path",
    "reveal",
    "write_pdf",
]

JPEG_QUALITY = 80
JPEG_SUBSAMPLING = 2

#: G10. A warning the pipeline reports, never a failure it raises.
PAGE_SIZE_WARN_BYTES = 700 * 1024

_VERSION = "0.1.0"


@dataclass(frozen=True)
class BuildStamp:
    """What goes in the PDF's `Producer`.

    A build that is not sitting on a clean tag stamps its sha into the metadata, so a
    dev-rendered PDF cannot be submitted without the evidence being right there in the
    document properties. When we cannot tell — no git, no repo, a stripped wheel — we
    stamp it as a dev build. That is the safe direction to be wrong in.
    """

    release: bool
    tag: str | None
    sha: str | None

    @property
    def producer(self) -> str:
        """ASCII only: img2pdf encodes Producer as ASCII and raises on anything else."""
        if self.release and self.tag:
            return _ascii(f"assignment-helper {self.tag}")
        sha = self.sha or "unknown-sha"
        return _ascii(f"assignment-helper {_VERSION} DEV BUILD {sha} - not a release render")


def _ascii(text: str) -> str:
    """Strip to ASCII. img2pdf writes Producer with .encode("ascii") and a tag with a
    non-ASCII character would otherwise blow up AFTER every page had been rasterized."""
    return text.encode("ascii", "replace").decode("ascii")


def build_stamp(repo_root: Path | None = None, *, runner=subprocess.run) -> BuildStamp:
    """Ask git whether HEAD is exactly a tag. Any doubt resolves to 'dev build'."""
    root = repo_root or Path(__file__).resolve().parents[2]

    def git(*args: str) -> str | None:
        try:
            done = runner(
                ["git", "-C", str(root), *args],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            # Not swallowed: the caller still gets a stamp, and it is the DEV stamp.
            # Failing closed here is the point of the whole mechanism.
            return None
        if done.returncode != 0:
            return None
        return done.stdout.strip() or None

    sha = git("rev-parse", "--short", "HEAD")
    tag = git("describe", "--exact-match", "--tags", "HEAD")
    dirty = git("status", "--porcelain")
    release = tag is not None and not dirty
    return BuildStamp(release=release, tag=tag, sha=sha)


def encode_jpeg(img: Image.Image, dest: Path, dpi: int) -> int:
    """Write one page as JPEG at the fixed settings. Returns the file size in bytes."""
    rgb = img if img.mode == "RGB" else img.convert("RGB")
    try:
        rgb.save(
            dest,
            format="JPEG",
            quality=JPEG_QUALITY,
            subsampling=JPEG_SUBSAMPLING,
            dpi=(dpi, dpi),
            optimize=True,
            progressive=False,
        )
    except OSError as err:
        raise ExportDiskError(
            f"Could not write the page image to {dest}: {err}. "
            "The disk is full or the temporary directory is not writable. "
            "Free some space and export again; nothing was left behind.",
            detail=f"{type(err).__name__}: {err}",
        ) from err
    return dest.stat().st_size


def resolve_output_path(document_path: str | None, title: str, fallback_dir: Path) -> Path:
    """Where the PDF goes: beside the document, or in `fallback_dir` if it has no file yet.

    The path comes from the client, so the parent directory is resolved and checked
    before anything is written. A path that does not exist is a named error up front,
    never a traceback after twenty pages have been rasterized.
    """
    if document_path:
        doc = Path(document_path).expanduser()
        parent = doc.parent.resolve()
        stem = doc.stem or _slug(title)
    else:
        parent = fallback_dir.expanduser().resolve()
        stem = _slug(title)

    if not parent.is_dir():
        raise ExportDestinationError(
            f"Cannot write the PDF: {parent} is not a directory that exists. "
            "Save the document somewhere first, or move it back to where it was.",
            detail=str(parent),
        )
    if not os.access(parent, os.W_OK):
        raise ExportDestinationError(
            f"Cannot write the PDF: {parent} is not writable. "
            "Check the folder's permissions, or move the document somewhere you own.",
            detail=str(parent),
        )
    return parent / f"{stem}.pdf"


def _slug(title: str) -> str:
    kept = [c if c.isalnum() or c in "-_" else "-" for c in title.strip()]
    slug = "".join(kept).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug[:80] or "assignment"


def write_pdf(jpegs: list[Path], dest: Path, *, producer: str) -> int:
    """Assemble the JPEGs into a PDF at `dest`. Returns the size in bytes.

    Written to a sibling temp file and moved into place with os.replace (invariant I10),
    so an interrupted run never leaves a truncated PDF where a finished one should be.
    """
    if not jpegs:
        raise ExportDestinationError(
            "Refusing to write a PDF with no pages. An empty document still exports "
            "one blank page; zero pages means the rasterize loop produced nothing.",
            detail="jpegs=[]",
        )

    tmp = dest.with_name(f".{dest.name}.partial")
    try:
        payload = img2pdf.convert([str(p) for p in jpegs], producer=producer)
        with open(tmp, "wb") as fh:
            fh.write(payload)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dest)
    except OSError as err:
        _unlink_quietly(tmp)
        _unlink_quietly(dest)
        raise ExportDiskError(
            f"Could not write the PDF to {dest}: {err}. "
            "The disk is full or the folder is not writable. The partial PDF and every "
            "temporary page have been deleted; free some space and export again.",
            detail=f"{type(err).__name__}: {err}",
        ) from err
    except Exception:
        # Re-raised untouched with its own name; we only make sure the partial goes.
        _unlink_quietly(tmp)
        raise
    return dest.stat().st_size


def _unlink_quietly(path: Path) -> None:
    """Remove a file we are already failing over.

    This is the one place a missing-file error is genuinely not information: we are in
    the cleanup arm of a failure that is about to be raised with its own name, and
    'the partial we wanted to delete was never created' is the good outcome. Every other
    OSError is re-raised so a permissions problem cannot hide here.
    """
    try:
        path.unlink()
    except FileNotFoundError:
        return
    except OSError as err:
        raise ExportDiskError(
            f"Could not delete the partial file {path}: {err}. "
            "Delete it by hand before exporting again — it is not a finished PDF.",
            detail=f"{type(err).__name__}: {err}",
        ) from err


def reveal(path: Path, *, enabled: bool = True, runner=subprocess.run) -> bool:
    """Show the finished PDF in the Finder. Returns whether the reveal actually ran."""
    if not enabled:
        return False
    if sys.platform != "darwin":
        return False
    opener = shutil.which("open")
    if opener is None:
        # Named, not swallowed: the PDF exists and the path is in the response, so the
        # export succeeded — but the user should know why nothing popped up.
        print(f"[export] `open` is not on PATH; the PDF is at {path}", file=sys.stderr)
        return False
    try:
        runner([opener, "-R", str(path)], check=False, timeout=5)
    except (OSError, subprocess.SubprocessError) as err:
        print(f"[export] could not reveal {path} in the Finder: {err}", file=sys.stderr)
        return False
    return True
