"""Router: glyphs. Registered by the frozen app.py; owned by the glyph-extract strand.

Seven endpoints and no more:

    POST /api/glyphs/sheet             generate the tracing-sheet PDF
    POST /api/glyphs/extract/begin     open an extraction session
    POST /api/glyphs/extract/page/{j}  ONE sheet photo, raw bytes
    POST /api/glyphs/extract/run/{j}   run it; returns immediately, poll for progress
    GET  /api/glyphs/progress/{j}      poll a running extraction
    GET  /api/glyphs/profiles          list the profiles already on disk
    GET  /api/glyphs/profile/{pid}     one profile's coverage and failed cells
    GET  /api/glyphs/health

Photos arrive as `application/octet-stream`, one per request, exactly as the export
router takes its pages. That is not copied for symmetry's sake: FastAPI's `UploadFile`
needs `python-multipart`, which is not a dependency of this project, and adding a
runtime dependency to satisfy one upload endpoint would be paid by every launch. Raw
bytes need nothing.

*** WHY THIS FILE USES importlib, AND WHY THAT IS NOT CARGO CULT ***

Invariant I17 says the CV stack may be imported only inside function bodies under
`assignment_helper/glyphs/**`. That wording is necessary but NOT sufficient, and this
was verified rather than assumed: import-linter's graph builder (grimp) records an
import from its AST, and it does not care whether the `import cv2` sits at module
scope or six levels deep inside a function. A plain

    from assignment_helper.glyphs import pipeline        # at module scope OR in a def

anywhere in this file creates the static chain

    app -> routers.glyphs -> glyphs.pipeline -> ... -> cv2

and the contract fails, no matter how lazy the leaf import is. Measured: it reports
`assignment_helper.glyphs -> cv2 (l.2)` for an import on line 2 of a function body.

So the bridge across that seam is `importlib.import_module`, resolved at call time
from a string. grimp cannot follow it, the static chain is broken, and cv2 genuinely
is not imported until someone actually extracts glyphs — which is the real point:
gate G13b exists because importing the CV stack costs 2.7 s on a cold cache and the
server must start in under five seconds.

Every glyphs module is loaded through `_glyphs()`. Do not "tidy" these into top-level
imports; the import-linter contract will fail the build and `scripts/integrate.sh`
runs it.
"""

from __future__ import annotations

import importlib
import threading
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/glyphs", tags=["glyphs"])

IMPLEMENTED = True

#: Extraction is CPU-bound and takes tens of seconds, so it runs on a worker thread and
#: the client polls. One registry per process; the id is still checked so a stale tab
#: cannot read a job it did not start.
_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()


def _glyphs(module: str):
    """Import one `assignment_helper.glyphs.*` module at CALL time. See the module docstring."""
    return importlib.import_module(f"assignment_helper.glyphs.{module}")


def _problem(exc: Any, status: int) -> HTTPException:
    return HTTPException(status_code=status, detail=exc.as_problem())


def _http_for(exc: Any) -> HTTPException:
    """Map a named extraction failure onto a status code.

    The codes are compared as strings so this function does not have to import the
    error classes — which live under `glyphs/**` and would re-create the static edge
    this file exists to avoid.
    """
    status = {
        "glyphs.markers-not-found": 422,
        "glyphs.sheet-unreadable": 400,
        "glyphs.sheet-too-sparse": 422,
        "glyphs.profile-write": 507,
    }.get(getattr(exc, "code", ""), 500)
    return _problem(exc, status)


class SheetRequest(BaseModel):
    destination: str = Field(description="Where to write the tracing-sheet PDF.")


class ExtractRequest(BaseModel):
    profile_id: str = Field(min_length=1, max_length=64)
    #: The colour drop is UNVERIFIED on real paper (plan §C.5.5). It is exposed as a
    #: switch precisely so a user whose camera greys out the non-photo blue can turn
    #: it off and still get a profile.
    drop_blue: bool = True


@router.get("/health")
async def health() -> dict[str, object]:
    return {"router": "glyphs", "implemented": IMPLEMENTED}


@router.post("/sheet")
async def make_sheet(request: SheetRequest) -> dict[str, object]:
    """Write the tracing-sheet PDF and return where it went."""
    sheet = _glyphs("sheet")
    errors = _glyphs("errors")
    from pathlib import Path

    try:
        written = sheet.write_sheet_pdf(Path(request.destination).expanduser())
    except errors.GlyphExtractionError as exc:
        raise _http_for(exc) from exc

    charset = _glyphs("charset")
    layout = _glyphs("layout")
    return {
        "path": str(written),
        "pages": charset.REPEATS,
        "cellsPerPage": layout.CELLS_PER_PAGE,
        "characters": len(charset.CHARSET),
        # Surfaced on every sheet response, not buried: the user is about to spend an
        # hour writing on this paper and the colour drop under it is untested.
        "colourDropVerifiedOnPaper": False,
    }


@router.get("/profiles")
async def list_profiles() -> dict[str, object]:
    paths = _glyphs("paths")
    return {"profiles": paths.list_profiles()}


@router.get("/profile/{profile_id}")
async def get_profile(profile_id: str) -> dict[str, object]:
    """Coverage and failed cells for one profile.

    Deliberately does NOT return the outlines. They are the user's handwriting (I9)
    and they are large; the browser provider reads the file from disk itself.
    """
    profile_mod = _glyphs("profile")
    errors = _glyphs("errors")
    try:
        profile = profile_mod.load_profile(profile_id)
    except errors.GlyphExtractionError as exc:
        raise _http_for(exc) from exc

    return {
        "profileId": profile["profileId"],
        "status": profile["status"],
        "unitsPerEm": profile["unitsPerEm"],
        "createdAt": profile["createdAt"],
        "coverage": profile["coverage"],
        "extraction": profile["extraction"],
        "failedCells": profile["failedCells"],
    }


@router.post("/extract/begin")
async def extract_begin(request: ExtractRequest) -> dict[str, object]:
    """Open an extraction session and return the job id to upload pages against."""
    errors = _glyphs("errors")
    paths = _glyphs("paths")

    try:
        paths.validate_profile_id(request.profile_id)
    except errors.GlyphExtractionError as exc:
        raise _http_for(exc) from exc

    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _JOBS[job_id] = {
            "state": "collecting",
            "profileId": request.profile_id,
            "dropBlue": request.drop_blue,
            "photos": [],
            "progress": None,
            "result": None,
            "problem": None,
        }
    return {"jobId": job_id, "state": "collecting"}


def _job(job_id: str) -> dict[str, Any]:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "glyphs.unknown-job",
                "message": f"There is no glyph-extraction job {job_id!r}.",
            },
        )
    return job


@router.post("/extract/page/{job_id}")
async def extract_page(job_id: str, request: Request) -> dict[str, object]:
    """Accept one sheet photo as raw bytes.

    The bytes are held in memory and never written to a temp file: a tracing-sheet
    photo is the user's handwriting (I9), and the fewer copies of it that touch the
    disk, the fewer there are to leak or forget to delete.
    """
    job = _job(job_id)
    if job["state"] != "collecting":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "glyphs.job-not-collecting",
                "message": f"Job {job_id!r} is {job['state']}, so it cannot take more photos.",
            },
        )

    body = await request.body()
    if not body:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "glyphs.empty-photo",
                "message": "That upload contained no bytes.",
            },
        )

    with _JOBS_LOCK:
        _JOBS[job_id]["photos"].append(body)
        count = len(_JOBS[job_id]["photos"])
    return {"jobId": job_id, "pagesReceived": count}


@router.post("/extract/run/{job_id}")
async def extract_run(job_id: str) -> dict[str, object]:
    """Start the extraction on a worker thread. Poll `/progress/{job_id}`."""
    pipeline = _glyphs("pipeline")
    errors = _glyphs("errors")

    job = _job(job_id)
    if job["state"] != "collecting":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "glyphs.job-not-collecting",
                "message": f"Job {job_id!r} has already been started.",
            },
        )

    blobs = list(job["photos"])
    profile_id = job["profileId"]
    drop_blue = job["dropBlue"]

    if not blobs:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "glyphs.no-photos",
                "message": "No tracing-sheet photos were uploaded for this job.",
            },
        )

    with _JOBS_LOCK:
        # The photos are dropped from the job the moment the worker owns them, so a
        # finished job does not sit in memory holding the user's handwriting (I9).
        _JOBS[job_id].update(state="running", photos=[])

    def on_progress(progress: Any) -> None:
        with _JOBS_LOCK:
            _JOBS[job_id]["progress"] = progress.as_dict()

    def run() -> None:
        try:
            result = pipeline.extract(
                blobs, profile_id, drop_blue=drop_blue, on_progress=on_progress
            )
        except errors.GlyphExtractionError as exc:
            # A HARD failure. No profile was written, and the job says so with a named
            # code rather than a bare 500 (I5).
            with _JOBS_LOCK:
                _JOBS[job_id].update(state="failed", problem=exc.as_problem())
            return
        except Exception as exc:  # noqa: BLE001 - re-raised to the client as a Problem
            # Not a swallow: the failure is recorded and returned to the caller. An
            # unexpected exception on a worker thread would otherwise vanish entirely,
            # which is the silent failure I5 forbids.
            with _JOBS_LOCK:
                _JOBS[job_id].update(
                    state="failed",
                    problem={
                        "scope": "app",
                        "code": "glyphs.unexpected",
                        "message": "Glyph extraction failed unexpectedly.",
                        "detail": f"{type(exc).__name__}: {exc}",
                    },
                )
            return

        with _JOBS_LOCK:
            _JOBS[job_id].update(
                state="done",
                result={
                    "profileId": profile_id,
                    "status": result.profile["status"],
                    "writtenTo": str(result.written_to) if result.written_to else None,
                    "coverage": result.profile["coverage"],
                    "failedCells": result.profile["failedCells"],
                    "timings": result.timings.as_dict(),
                    "warning": pipeline.viability_warning(result),
                },
            )

    threading.Thread(target=run, name=f"glyph-extract-{job_id[:8]}", daemon=True).start()
    return {"jobId": job_id, "state": "running", "pages": len(blobs)}


@router.get("/progress/{job_id}")
async def progress(job_id: str) -> dict[str, object]:
    """Poll one job.

    Returns named fields rather than the job dict, deliberately: the job also holds
    the uploaded photo BYTES, and spreading it into the response would serialise the
    user's handwriting straight back over the wire (I9) as well as failing to encode.
    """
    job = _job(job_id)
    with _JOBS_LOCK:
        return {
            "jobId": job_id,
            "state": job["state"],
            "profileId": job["profileId"],
            "pagesReceived": len(job["photos"]),
            "progress": job["progress"],
            "result": job["result"],
            "problem": job["problem"],
        }
