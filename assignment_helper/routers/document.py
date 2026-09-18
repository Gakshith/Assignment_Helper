"""Router: document. Snapshot out, deltas in.

Owned by the document strand. `app.py` registers it at the seam-freeze and never
changes.

WHERE THE STORE COMES FROM. `app.py` is frozen and does not construct a store, so the
server strand puts one on `app.state` with `set_document_store(app, store)` when it
opens a file. Until then every route here returns a named 409, never an empty document:
"no document is open" and "the document is empty" are different facts and a client that
cannot tell them apart will happily show a blank page as if it were the homework
(invariant I5).

STATUS CODES, so the client never has to guess from a 500:
  409 document.none-open      nothing is open yet
  409 document.delta-rejected parent_version mismatch; body carries current_version
                              and the caller re-fetches /snapshot (invariant I4)
  422 document.<op code>      the delta was well-formed but could not be applied
  500                         only for faults we did not anticipate
"""

from __future__ import annotations

from fastapi import APIRouter, FastAPI, HTTPException, Request

from assignment_helper.document.ops import OpFailed
from assignment_helper.document.schema import Delta, Snapshot, Style
from assignment_helper.document.store import DeltaRejected, DocumentStore

router = APIRouter(prefix="/api/document", tags=["document"])

IMPLEMENTED = True

_STATE_ATTR = "document_store"


def set_document_store(app: FastAPI, store: DocumentStore) -> None:
    """The server strand calls this once it has opened a file."""
    setattr(app.state, _STATE_ATTR, store)


def get_document_store(app: FastAPI) -> DocumentStore | None:
    return getattr(app.state, _STATE_ATTR, None)


def _require_store(request: Request) -> DocumentStore:
    store = get_document_store(request.app)
    if store is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "document.none-open",
                "message": (
                    "No document is open. Start assignment-helper with a file "
                    "(`assignment-helper hw7.md`) or POST the path to "
                    "/api/ingest/file first."
                ),
            },
        )
    return store


@router.get("/health")
async def health() -> dict[str, object]:
    return {"router": "document", "implemented": IMPLEMENTED}


@router.get("/snapshot")
async def snapshot(request: Request) -> Snapshot:
    """The whole document plus its version. The client's resync path."""
    return _require_store(request).snapshot()


@router.post("/delta")
async def post_delta(request: Request, delta: Delta) -> Snapshot:
    store = _require_store(request)
    try:
        return store.apply(delta)
    except DeltaRejected as exc:
        # Never a bare 500, and never a silent merge. The client is told exactly what
        # to resync to (invariant I4).
        raise HTTPException(
            status_code=409,
            detail={
                "code": "document.delta-rejected",
                "message": str(exc),
                "parent_version": exc.parent_version,
                "current_version": exc.current_version,
            },
        ) from exc
    except OpFailed as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": exc.code,
                "message": exc.message,
                "block_id": exc.block_id,
                "current_version": store.version,
            },
        ) from exc


@router.post("/style")
async def post_style(request: Request, style: Style) -> Snapshot:
    """Style-only change. Sugar over a one-op delta at the current version, because the
    style panel has no reason to know about version arithmetic."""
    store = _require_store(request)
    delta = Delta(parent_version=store.version, ops=[{"op": "style", "style": style}])
    return await post_delta(request, delta)
