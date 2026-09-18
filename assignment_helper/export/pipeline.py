"""The spool. One page at a time, on disk, never all in memory.

    browser: paint at export DPI in a Worker + OffscreenCanvas
           -> raw RGBA POST, ONE PAGE AT A TIME
    here:    spool to disk -> artifact pass -> JPEG -> img2pdf -> PDF -> reveal

Paging is what keeps gate G11 (browser tab <=1.2 GB during a 20-page export) reachable
on both sides of the wire. A 200 DPI letter page is 1700 x 2200 x 4 = 14.96 MB of raw
RGBA; twenty of them held at once is 300 MB on the server and the same again in the tab.
So each page is written to the spool directory the moment it lands and dropped.

Every failure path removes everything this export wrote — the partial PDF and every
spooled page — before the error escapes (acceptance row 14). The temp directory is gone
afterwards, not merely empty.

I17: Pillow only. No numpy, not even inside a function body — that allowance is for
`assignment_helper/glyphs/**`, and this is not that.
"""

from __future__ import annotations

import os
import secrets
import shutil
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from assignment_helper.export.artifacts import ArtifactParams, apply_artifacts
from assignment_helper.export.errors import (
    ExportAborted,
    ExportDestinationError,
    ExportDiskError,
    ExportProtocolError,
)
from assignment_helper.export.pdf import (
    PAGE_SIZE_WARN_BYTES,
    build_stamp,
    encode_jpeg,
    resolve_output_path,
    reveal,
    write_pdf,
)

__all__ = [
    "STALE_SESSION_SECONDS",
    "ExportResult",
    "ExportSession",
    "ExportSessions",
    "PageSpool",
    "write_page_bytes",
]

#: Backstop for acceptance row 13. The client sends an explicit abort beacon on
#: pagehide, which lands in milliseconds; this only catches the case where the beacon
#: itself was lost — a hard kill, a crashed renderer. It is deliberately longer than the
#: 20 s per-page rasterize timeout (I6) so a slow page is never mistaken for a dead tab.
STALE_SESSION_SECONDS = 45.0

_RGBA_BYTES_PER_PIXEL = 4


def write_page_bytes(path: Path, data: bytes) -> int:
    """The single funnel for spool writes.

    Every raw page goes through here so acceptance row 14 can be tested by patching one
    function rather than by filling a real disk.
    """
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)


@dataclass(frozen=True)
class PageSpool:
    index: int
    path: Path
    width: int
    height: int
    nbytes: int
    #: Server-side receive + decode-header cost, in ms. Gate G7.
    receive_ms: float


@dataclass(frozen=True)
class ExportResult:
    path: Path
    size_bytes: int
    pages: int
    producer: str
    artifacts: bool
    revealed: bool
    #: Per-page artifact + encode cost, in ms. Gate G8.
    artifact_ms: list[float]
    #: Per-page JPEG size, in bytes. Gate G10 — a warning, never a failure.
    page_bytes: list[int]
    oversized_pages: list[int]


@dataclass
class ExportSession:
    id: str
    dir: Path
    dpi: int
    page_count: int
    page_w_px: int
    page_h_px: int
    document_path: str | None
    title: str
    seed: int
    no_artifacts: bool
    fallback_dir: Path
    pages: dict[int, PageSpool] = field(default_factory=dict)
    started_at: float = field(default_factory=time.monotonic)
    touched_at: float = field(default_factory=time.monotonic)
    finished: bool = False
    aborted_reason: str | None = None

    @property
    def expected_page_bytes(self) -> int:
        return self.page_w_px * self.page_h_px * _RGBA_BYTES_PER_PIXEL


class ExportSessions:
    """The live export registry. One open document per server process in v1, but a
    session id is still carried so a stale tab cannot finish someone else's export."""

    def __init__(
        self,
        *,
        root: Path | None = None,
        stale_after: float = STALE_SESSION_SECONDS,
        clock=time.monotonic,
    ) -> None:
        self._root = root
        self._stale_after = stale_after
        self._clock = clock
        self._lock = threading.Lock()
        self._sessions: dict[str, ExportSession] = {}

    # ------------------------------------------------------------------ lifecycle

    def begin(
        self,
        *,
        dpi: int,
        page_count: int,
        page_w_px: int,
        page_h_px: int,
        document_path: str | None,
        title: str,
        seed: int,
        no_artifacts: bool,
        fallback_dir: Path,
    ) -> ExportSession:
        if page_count < 1:
            raise ExportProtocolError(
                f"An export needs at least one page, got {page_count}. "
                "An empty document still exports one blank page (acceptance row 23); "
                "zero pages means layout produced no geometry at all.",
                detail=f"page_count={page_count}",
            )
        if page_w_px < 1 or page_h_px < 1:
            raise ExportProtocolError(
                f"Page size must be positive, got {page_w_px}x{page_h_px} px.",
                detail=f"{page_w_px}x{page_h_px}",
            )
        if dpi < 1:
            raise ExportProtocolError(f"Export DPI must be positive, got {dpi}.", detail=str(dpi))

        # Resolved BEFORE a single page is rasterized: finding out the destination is
        # unwritable after twenty pages of work is the wrong time to find out.
        resolve_output_path(document_path, title, fallback_dir)

        self.sweep()
        sid = secrets.token_urlsafe(16)
        spool = Path(tempfile.mkdtemp(prefix=f"ah-export-{sid[:8]}-", dir=self._root))
        session = ExportSession(
            id=sid,
            dir=spool,
            dpi=dpi,
            page_count=page_count,
            page_w_px=page_w_px,
            page_h_px=page_h_px,
            document_path=document_path,
            title=title,
            seed=seed,
            no_artifacts=no_artifacts,
            fallback_dir=fallback_dir,
            started_at=self._clock(),
            touched_at=self._clock(),
        )
        with self._lock:
            self._sessions[sid] = session
        return session

    def get(self, sid: str) -> ExportSession:
        with self._lock:
            session = self._sessions.get(sid)
        if session is None:
            raise ExportProtocolError(
                f"Export session {sid!r} is not open. It either finished, was cancelled, "
                "or timed out because the tab stopped sending pages. Start the export again.",
                detail=sid,
            )
        if session.aborted_reason is not None:
            raise ExportAborted(
                f"This export was cancelled: {session.aborted_reason}. "
                "Nothing was written; start the export again.",
                detail=session.aborted_reason,
            )
        return session

    # ------------------------------------------------------------------ pages

    def add_page(self, sid: str, index: int, raw: bytes, width: int, height: int) -> PageSpool:
        """Spool one raw RGBA page to disk. Gate G7 measures this call."""
        t0 = time.perf_counter()
        session = self.get(sid)

        if not 0 <= index < session.page_count:
            raise ExportProtocolError(
                f"Page index {index} is outside this export's range 0..{session.page_count - 1}.",
                detail=f"index={index} page_count={session.page_count}",
            )
        if width != session.page_w_px or height != session.page_h_px:
            raise ExportProtocolError(
                f"Page {index} arrived at {width}x{height} px but the export was opened at "
                f"{session.page_w_px}x{session.page_h_px}. Every page of one export is the "
                "same size; a mismatch means the DPI changed mid-export.",
                detail=f"got {width}x{height}, want {session.page_w_px}x{session.page_h_px}",
            )
        expected = session.expected_page_bytes
        if len(raw) != expected:
            raise ExportProtocolError(
                f"Page {index} carried {len(raw)} bytes but {width}x{height} RGBA is "
                f"{expected} bytes. The buffer was truncated in transit; the export is "
                "refused rather than padded.",
                detail=f"got {len(raw)} want {expected}",
            )

        dest = session.dir / f"page-{index:04d}.rgba"
        try:
            written = write_page_bytes(dest, raw)
        except OSError as err:
            self.abort(sid, f"could not spool page {index}: {err}")
            raise ExportDiskError(
                f"Could not write page {index} to the spool at {dest}: {err}. "
                "The disk is full. Every spooled page has been deleted and no PDF was "
                "written; free some space and export again.",
                detail=f"{type(err).__name__}: {err}",
            ) from err

        spool = PageSpool(
            index=index,
            path=dest,
            width=width,
            height=height,
            nbytes=written,
            receive_ms=(time.perf_counter() - t0) * 1000.0,
        )
        session.pages[index] = spool
        session.touched_at = self._clock()
        return spool

    # ------------------------------------------------------------------ finish

    def finish(self, sid: str, *, do_reveal: bool = True, params: ArtifactParams | None = None) -> ExportResult:
        session = self.get(sid)
        missing = [i for i in range(session.page_count) if i not in session.pages]
        if missing:
            self.abort(sid, f"pages {missing} never arrived")
            raise ExportProtocolError(
                f"Cannot finish the export: page(s) {missing} never arrived. "
                "The rasterize loop stopped early; nothing was written.",
                detail=f"missing={missing}",
            )

        dest = resolve_output_path(session.document_path, session.title, session.fallback_dir)
        stamp = build_stamp()
        jpegs: list[Path] = []
        artifact_ms: list[float] = []
        page_bytes: list[int] = []

        try:
            for index in range(session.page_count):
                spool = session.pages[index]
                t0 = time.perf_counter()
                jpeg = session.dir / f"page-{index:04d}.jpg"
                size = self._render_page(session, spool, jpeg, params)
                artifact_ms.append((time.perf_counter() - t0) * 1000.0)
                page_bytes.append(size)
                jpegs.append(jpeg)
                # The raw page has served its purpose; drop it so the spool never holds
                # both representations of every page at once.
                spool.path.unlink(missing_ok=True)

            size_bytes = write_pdf(jpegs, dest, producer=stamp.producer)
        except BaseException:
            # Row 14 and every other failure: the partial PDF and the whole spool go,
            # then the named error continues on its way untouched.
            _remove_tree(session.dir)
            _remove_file(dest.with_name(f".{dest.name}.partial"))
            self._forget(sid)
            raise

        _remove_tree(session.dir)
        session.finished = True
        self._forget(sid)

        revealed = reveal(dest, enabled=do_reveal)
        oversized = [i for i, n in enumerate(page_bytes) if n > PAGE_SIZE_WARN_BYTES]
        if oversized:
            # G10 is a warning by design. Printed, never raised, and never "fixed" by
            # degrading the render: paper grain is high-entropy on purpose.
            print(
                f"[export] G10 warning: page(s) {oversized} exceed "
                f"{PAGE_SIZE_WARN_BYTES // 1024} KB at {session.dpi} DPI. "
                "This is expected with heavy paper grain and is not a failure.",
            )

        return ExportResult(
            path=dest,
            size_bytes=size_bytes,
            pages=session.page_count,
            producer=stamp.producer,
            artifacts=not session.no_artifacts,
            revealed=revealed,
            artifact_ms=artifact_ms,
            page_bytes=page_bytes,
            oversized_pages=oversized,
        )

    def _render_page(
        self,
        session: ExportSession,
        spool: PageSpool,
        jpeg: Path,
        params: ArtifactParams | None,
    ) -> int:
        raw = spool.path.read_bytes()
        img = Image.frombuffer(
            "RGBA", (spool.width, spool.height), raw, "raw", "RGBA", 0, 1
        ).convert("RGB")

        if not session.no_artifacts:
            # Per-page seed: two pages of one document are two separate captures, but
            # the same document always exports to the same bytes.
            img = apply_artifacts(
                img, seed=session.seed ^ (spool.index * 0x9E3779B1), dpi=session.dpi, params=params
            )
        return encode_jpeg(img, jpeg, session.dpi)

    # ------------------------------------------------------------------ abort

    def abort(self, sid: str, reason: str) -> bool:
        """Cancel an in-flight export and delete everything it wrote.

        Acceptance rows 11 and 13 both land here. An export is never resumed from a
        half state — there is no resume path at all, by design.
        """
        with self._lock:
            session = self._sessions.pop(sid, None)
        if session is None:
            return False
        session.aborted_reason = reason
        _remove_tree(session.dir)
        try:
            dest = resolve_output_path(session.document_path, session.title, session.fallback_dir)
        except ExportDestinationError:
            # The destination was already unresolvable, so there is no partial PDF of
            # ours to remove. Nothing is hidden: the spool is gone either way, and the
            # caller is cancelling, not exporting.
            return True
        _remove_file(dest.with_name(f".{dest.name}.partial"))
        return True

    def sweep(self, now: float | None = None) -> list[str]:
        """Drop sessions whose tab stopped talking. Backstop for acceptance row 13."""
        cutoff = (now if now is not None else self._clock()) - self._stale_after
        with self._lock:
            stale = [s.id for s in self._sessions.values() if s.touched_at < cutoff]
        for sid in stale:
            self.abort(sid, "the tab stopped sending pages")
        return stale

    def _forget(self, sid: str) -> None:
        with self._lock:
            self._sessions.pop(sid, None)

    # ------------------------------------------------------------------ introspection

    @property
    def open_ids(self) -> list[str]:
        with self._lock:
            return list(self._sessions)

    def shutdown(self) -> None:
        for sid in self.open_ids:
            self.abort(sid, "the server is shutting down")


def _remove_tree(path: Path) -> None:
    if not path.exists():
        return
    try:
        shutil.rmtree(path)
    except OSError as err:
        # Named rather than swallowed: leftover spool files are 15 MB each, and a user
        # who is out of disk needs to be told exactly what to delete.
        raise ExportDiskError(
            f"Could not delete the export spool at {path}: {err}. "
            f"Delete that directory by hand — it holds raw page images.",
            detail=f"{type(err).__name__}: {err}",
        ) from err


def _remove_file(path: Path) -> None:
    try:
        os.unlink(path)
    except FileNotFoundError:
        return
    except OSError as err:
        raise ExportDiskError(
            f"Could not delete the partial PDF at {path}: {err}. "
            "Delete it by hand — it is not a finished PDF.",
            detail=f"{type(err).__name__}: {err}",
        ) from err
