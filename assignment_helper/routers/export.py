"""Router: export. Registered by the frozen app.py; owned by the export strand.

Five endpoints and no more:

    POST /api/export/begin            open a session, resolve the destination up front
    POST /api/export/page/{sid}       ONE page of raw RGBA, spooled to disk        (G7)
    POST /api/export/finish/{sid}     artifact pass -> JPEG -> img2pdf -> reveal   (G8)
    POST /api/export/abort/{sid}      delete the partial and everything spooled
    GET  /api/export/health

Pages arrive as `application/octet-stream`, raw RGBA, one page per request. They are not
base64'd and not JSON-wrapped: 15 MB of pixels through a JSON encoder would cost more
than the whole gate G7 budget of 40 ms.

Every error leaves here as a named `Problem` body (invariant I5), never a bare 500 and
never an empty 200. The abort endpoint accepts the token as `?t=` as well as the
`x-ah-token` header (the frozen security.py allows both) because `navigator.sendBeacon`,
which is the only thing that reliably fires while a tab is closing, cannot set headers.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from assignment_helper.export.errors import (
    ExportAborted,
    ExportBlocked,
    ExportDestinationError,
    ExportDiskError,
    ExportError,
    ExportProtocolError,
)
from assignment_helper.export.pipeline import ExportSessions

router = APIRouter(prefix="/api/export", tags=["export"])

IMPLEMENTED = True

#: One registry per process. v1 has one open document, but the id is still checked so a
#: stale tab cannot finish an export it did not start.
SESSIONS = ExportSessions()

_STATUS_FOR_CODE = {
    ExportProtocolError.code: 400,
    ExportBlocked.code: 409,
    ExportAborted.code: 409,
    ExportDestinationError.code: 400,
    ExportDiskError.code: 507,
}


def _http(err: ExportError) -> HTTPException:
    return HTTPException(
        status_code=_STATUS_FOR_CODE.get(err.code, 500),
        detail=err.as_problem(),
    )


class BeginRequest(BaseModel):
    dpi: int = Field(ge=1, le=1200)
    page_count: int = Field(ge=1, le=500)
    page_w_px: int = Field(ge=1)
    page_h_px: int = Field(ge=1)
    document_path: str | None = None
    title: str = ""
    seed: int = 0
    #: The client's read of the frozen `kernel.canExport`, and the block ids behind it.
    #: Plan §C.5.4: the overlay layer is NEVER composited into export, so export is
    #: refused outright while any block carries a problem badge. Both wrong answers —
    #: printing a red badge, or silently dropping the overflow warning — reach the
    #: professor, and refusing is the only behaviour that is safe in both directions.
    blocked_block_ids: list[str] = Field(default_factory=list)


class BeginResponse(BaseModel):
    session_id: str
    expected_page_bytes: int
    no_artifacts: bool


class FinishResponse(BaseModel):
    path: str
    size_bytes: int
    pages: int
    producer: str
    artifacts: bool
    revealed: bool
    artifact_ms: list[float]
    page_bytes: list[int]
    oversized_pages: list[int]


class AbortRequest(BaseModel):
    reason: str = "cancelled by the user"


@router.get("/health")
async def health(request: Request) -> dict[str, object]:
    config = getattr(request.app.state, "config", None)
    return {
        "router": "export",
        "implemented": IMPLEMENTED,
        "open_sessions": len(SESSIONS.open_ids),
        "no_artifacts": bool(getattr(config, "no_artifacts", False)),
        "dev_build": bool(getattr(config, "dev_build", True)),
    }


@router.post("/begin", response_model=BeginResponse)
async def begin(request: Request, body: BeginRequest) -> BeginResponse:
    if body.blocked_block_ids:
        named = ", ".join(sorted(body.blocked_block_ids))
        raise _http(
            ExportBlocked(
                "Export is blocked: these blocks still carry a problem badge — "
                f"{named}. Fix them and export again. The badges are never printed onto "
                "the PDF, so exporting now would hide the warning instead of showing it.",
                detail=named,
            )
        )

    config = getattr(request.app.state, "config", None)
    no_artifacts = bool(getattr(config, "no_artifacts", False))
    forced_dpi = getattr(config, "dpi", None)
    forced_seed = getattr(config, "seed", None)

    try:
        session = SESSIONS.begin(
            dpi=int(forced_dpi) if forced_dpi else body.dpi,
            page_count=body.page_count,
            page_w_px=body.page_w_px,
            page_h_px=body.page_h_px,
            document_path=body.document_path,
            title=body.title,
            seed=int(forced_seed) if forced_seed is not None else body.seed,
            no_artifacts=no_artifacts,
            fallback_dir=Path.cwd(),
        )
    except ExportError as err:
        raise _http(err) from err

    return BeginResponse(
        session_id=session.id,
        expected_page_bytes=session.expected_page_bytes,
        no_artifacts=no_artifacts,
    )


@router.post("/page/{session_id}")
async def add_page(session_id: str, request: Request) -> dict[str, object]:
    """One page of raw RGBA. Gate G7: receive + decode <= 40 ms."""
    try:
        index = int(request.headers["x-ah-page-index"])
        width = int(request.headers["x-ah-page-w"])
        height = int(request.headers["x-ah-page-h"])
    except (KeyError, ValueError) as err:
        raise _http(
            ExportProtocolError(
                "A page POST must carry x-ah-page-index, x-ah-page-w and x-ah-page-h as "
                f"integers. This one did not: {err}.",
                detail=str(err),
            )
        ) from err

    raw = await request.body()
    try:
        spool = SESSIONS.add_page(session_id, index, raw, width, height)
    except ExportError as err:
        raise _http(err) from err

    return {
        "index": spool.index,
        "bytes": spool.nbytes,
        "receive_ms": round(spool.receive_ms, 3),
    }


@router.post("/finish/{session_id}", response_model=FinishResponse)
async def finish(session_id: str, request: Request) -> FinishResponse:
    reveal_enabled = not bool(getattr(request.app.state, "export_suppress_reveal", False))
    try:
        result = SESSIONS.finish(session_id, do_reveal=reveal_enabled)
    except ExportError as err:
        raise _http(err) from err

    return FinishResponse(
        path=str(result.path),
        size_bytes=result.size_bytes,
        pages=result.pages,
        producer=result.producer,
        artifacts=result.artifacts,
        revealed=result.revealed,
        artifact_ms=[round(v, 3) for v in result.artifact_ms],
        page_bytes=result.page_bytes,
        oversized_pages=result.oversized_pages,
    )


@router.post("/abort/{session_id}")
async def abort(session_id: str, request: Request) -> dict[str, object]:
    """Cancel and delete. Acceptance rows 11 and 13 both arrive here.

    The body is read defensively because `sendBeacon` sends whatever the browser feels
    like on a closing tab — sometimes a Blob, sometimes nothing. A missing or unparseable
    body is not a failure to report; it is a tab that is already gone, and the reason
    string is the only thing lost.
    """
    reason = "cancelled by the user"
    raw = await request.body()
    if raw:
        try:
            reason = AbortRequest.model_validate_json(raw).reason
        except ValueError:
            reason = "cancelled by a closing tab (no readable reason sent)"

    deleted = SESSIONS.abort(session_id, reason)
    return {"session_id": session_id, "deleted": deleted, "reason": reason}
