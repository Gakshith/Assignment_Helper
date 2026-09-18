"""Chat and solve. Owned by one strand; app.py registers it and never changes.

This is §B.2's #1 and #2 differentiators — asking the AI about a SELECTION, and
editing what it wrote — and no competitor has either. Everything here goes through
`llm.payload.ChatPayload`, which cannot carry handwriting data by construction (I9).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict

from assignment_helper.llm.client import LLMClient, LLMProblem
from assignment_helper.llm.payload import ChatPayload
from assignment_helper.llm.prompts import CHAT_SYSTEM, SOLVER_SYSTEM, solve_user_message
from assignment_helper.llm.schemas import SolutionSet
from assignment_helper.llm.solver import solution_to_blocks, validate_solution

router = APIRouter(prefix="/api/chat", tags=["chat"])

IMPLEMENTED = True

_CLIENT_KEY = "llm_client"


def set_llm_client(app, client: LLMClient) -> None:
    """Called by cli.py at startup. Declared here so the caller is never in doubt —
    an earlier wave lost a whole subsystem because a registrar was written by one
    strand and called by neither."""
    setattr(app.state, _CLIENT_KEY, client)


def _client(request: Request) -> LLMClient:
    client = getattr(request.app.state, _CLIENT_KEY, None)
    if client is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "chat.no-client",
                "message": "The AI client was never registered. This is a wiring fault, not a key problem.",
            },
        )
    return client


def _as_http(problem: LLMProblem) -> HTTPException:
    #  Named, never generic (I5). The UI renders code + message directly.
    status = 401 if problem.code == "llm.authentication" else 502
    if problem.code in ("llm.no-key", "llm.offline"):
        status = 409
    if problem.code == "llm.spend-cap":
        status = 402
    return HTTPException(
        status_code=status,
        detail={"code": problem.code, "message": problem.message, "detail": problem.detail},
    )


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AskRequest(Strict):
    payload: ChatPayload


class SolveRequest(Strict):
    source: str


class SolveDocumentResponse(Strict):
    blocks: list[dict]
    review_required: bool
    low_confidence: list[str]
    latex_ok: bool
    latex_problems: str
    source_chars: int


@router.get("/health")
async def health(request: Request) -> dict[str, object]:
    client = getattr(request.app.state, _CLIENT_KEY, None)
    return {
        "router": "chat",
        "implemented": IMPLEMENTED,
        #  Acceptance row 1: the UI uses this to show "add a key" with the exact
        #  command rather than letting a click fail.
        "ai_available": bool(client and client.available),
    }


@router.post("/ask")
async def ask(request: Request, body: AskRequest) -> StreamingResponse:
    client = _client(request)

    def events():
        try:
            for ev in client.stream(system=CHAT_SYSTEM, messages=body.payload.to_messages()):
                yield f"data: {json.dumps({'kind': ev.kind, 'text': ev.text})}\n\n"
        except LLMProblem as problem:
            #  The stream has already started, so the failure travels as an event
            #  rather than a status code. It must still be named and must still say
            #  that nothing was applied.
            yield f"data: {json.dumps({'kind': 'problem', 'code': problem.code, 'text': problem.message})}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream")


@router.post("/solve-document", response_model=SolveDocumentResponse)
async def solve_document(request: Request) -> SolveDocumentResponse:
    """Solve the OPEN document and return the blocks that should replace it.

    This is the product's headline verb — the reason it is called Assignment_Helper and
    not markdown-to-handwriting — and for a long time the endpoint below existed with
    nothing calling it.

    It returns blocks rather than applying them. The caller sends them as one delta
    through the editor actions, so the whole solve is exactly ONE undo step (acceptance
    row 19) and the server stays the single source of truth (I4). Applying it here
    would put an AI edit outside the client's history, where the user could not take it
    back.
    """
    from assignment_helper.ingest.markdown import document_to_markdown
    from assignment_helper.routers.document import get_document_store

    client = _client(request)
    store = get_document_store(request.app)
    if store is None:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "solve.no-document",
                "message": "No document is open. Start assignment-helper with a file.",
            },
        )

    source = document_to_markdown(store.snapshot().document)
    result = await _solve_source(client, source)
    return SolveDocumentResponse(source_chars=len(source), **result)


async def _solve_source(client: LLMClient, source: str) -> dict[str, Any]:
    chunks: list[str] = []
    try:
        for ev in client.stream(
            system=SOLVER_SYSTEM,
            messages=[{"role": "user", "content": solve_user_message(source)}],
            max_tokens=16000,
        ):
            if ev.kind == "text":
                chunks.append(ev.text)
    except LLMProblem as problem:
        raise _as_http(problem) from problem

    raw = "".join(chunks).strip()
    try:
        solution = SolutionSet.model_validate_json(_strip_fence(raw))
    except Exception as exc:
        # Row 19: schema-validate before applying. On failure show the RAW response and
        # apply nothing. No partial application, ever.
        raise HTTPException(
            status_code=422,
            detail={
                "code": "solve.invalid-schema",
                "message": "The model's answer did not match the solution schema. Nothing was applied.",
                "raw": raw[:4000],
            },
        ) from exc

    report = validate_solution(solution)
    built = solution_to_blocks(solution)
    return {
        "blocks": [b.model_dump() for b in built.blocks],
        "review_required": built.review_required,
        "low_confidence": built.low_confidence,
        "latex_ok": report.ok,
        "latex_problems": report.summary() if not report.ok else "",
    }


def _strip_fence(raw: str) -> str:
    """Models wrap JSON in a ```json fence often enough to be worth handling here.

    Not a silent repair: if the fence is the only problem the parse succeeds, and if
    anything else is wrong the caller still sees the raw response verbatim.
    """
    text = raw.strip()
    if text.startswith("```"):
        newline = text.find("\n")
        if newline != -1:
            text = text[newline + 1 :]
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()


@router.post("/solve")
async def solve(request: Request, body: SolveRequest) -> dict[str, Any]:
    """Solve a problem set and return blocks, NOT a document.

    The caller applies them as a delta so the change is one undo step (row 19) and the
    server stays authoritative (I4).
    """
    client = _client(request)

    chunks: list[str] = []
    try:
        for ev in client.stream(
            system=SOLVER_SYSTEM,
            messages=[{"role": "user", "content": solve_user_message(body.source)}],
            max_tokens=16000,
        ):
            if ev.kind == "text":
                chunks.append(ev.text)
    except LLMProblem as problem:
        raise _as_http(problem) from problem

    raw = "".join(chunks).strip()
    try:
        solution = SolutionSet.model_validate_json(_strip_fence(raw))
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "solve.invalid-schema",
                "message": "The model's answer did not match the solution schema. Nothing was applied.",
                "raw": raw[:4000],
            },
        ) from exc

    report = validate_solution(solution)
    result = solution_to_blocks(solution)
    return {
        "blocks": [b.model_dump() for b in result.blocks],
        #  §C.5.2: doubt must be visible BEFORE the page is handed in.
        "review_required": result.review_required,
        "low_confidence": result.low_confidence,
        "latex_ok": report.ok,
        "latex_problems": report.summary() if not report.ok else "",
    }
