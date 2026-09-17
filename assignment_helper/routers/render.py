"""Stub router: render. Registered by app.py at the seam-freeze; owned by exactly one strand.

A stub returns valid empty data and NEVER pretends to have done the work. Every
not-built path raises a named 501 so integration cannot mistake an unimplemented
subsystem for an empty result (invariant I5).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/render", tags=["render"])

IMPLEMENTED = False


@router.get("/health")
async def health() -> dict[str, object]:
    return {"router": "render", "implemented": IMPLEMENTED}


def not_built(what: str) -> HTTPException:
    return HTTPException(
        status_code=501,
        detail={"code": "render.not-built", "message": f"{what} is not built yet."},
    )
