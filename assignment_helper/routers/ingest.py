"""Router: ingest. Markdown text in, and files off the user's disk.

Owned by the document strand. `assignment-helper hw7.md` is the product's headline
input path; this is the HTTP half of it.

`POST /api/ingest/file` reads a path on the user's machine. That is the whole point of a
local-first tool, and it is safe here only because `security.LocalAuthMiddleware` is in
front of it: session token, Host allowlist and a cross-site check (invariant I16). It
still refuses anything that is not a text-ish source file, so a mistyped path fails with
a message instead of dumping a binary into the document.

Parsing never raises on bad markdown — unsupported constructs come through as literal
prose. See `assignment_helper.ingest.markdown` for exactly which ones.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from assignment_helper.document.filestore import (
    DocumentReadError,
    FileDocumentStore,
    document_path_for,
)
from assignment_helper.document.migrations import DocumentTooNew
from assignment_helper.document.schema import Document, Snapshot
from assignment_helper.ingest.markdown import parse_markdown
from assignment_helper.routers.document import get_document_store, set_document_store

router = APIRouter(prefix="/api/ingest", tags=["ingest"])

IMPLEMENTED = True

# Text formats only. Anything else is a mistake worth naming rather than decoding.
SOURCE_SUFFIXES = frozenset({".md", ".markdown", ".mdown", ".txt", ".text"})
# A homework file is kilobytes. A gigabyte here means the path is wrong.
MAX_SOURCE_BYTES = 8 * 1024 * 1024


class MarkdownRequest(BaseModel):
    text: str
    doc_id: str = Field(default="untitled", min_length=1)
    source_path: str | None = None


class FileRequest(BaseModel):
    path: str = Field(min_length=1)
    open_document: bool = True


def _fail(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


@router.get("/health")
async def health() -> dict[str, object]:
    return {"router": "ingest", "implemented": IMPLEMENTED}


@router.post("/markdown")
async def ingest_markdown(body: MarkdownRequest) -> Document:
    """Parse markdown text into a Document without touching the disk."""
    return parse_markdown(body.text, doc_id=body.doc_id, source_path=body.source_path)


@router.post("/screenshot")
async def ingest_screenshot(request: Request) -> dict[str, object]:
    """Tier 3: a screenshot of the assignment becomes a Document.

    The image arrives as a raw body, not JSON: base64 in a JSON envelope costs a third
    more bytes and an encode/decode on both sides for a payload that is already binary.

    Returns the transcription and the parsed blocks WITHOUT applying them. The caller
    reviews first — a transcription is a reading of a photograph, and a misread exponent
    becomes a wrong answer three steps later that nothing downstream will catch.
    """
    from assignment_helper.ingest.markdown import parse_markdown
    from assignment_helper.ingest.vision import transcribe
    from assignment_helper.llm.client import LLMProblem
    from assignment_helper.routers.chat import get_llm_client

    client = get_llm_client(request.app)
    if client is None:
        raise _fail(503, "ingest.no-client", "The AI client was never registered.")

    image = await request.body()
    hint = request.headers.get("x-ah-hint", "")

    try:
        result = transcribe(client, image, hint=hint)
    except LLMProblem as problem:
        raise HTTPException(
            status_code=422 if problem.code.startswith("ingest.") else 502,
            detail={"code": problem.code, "message": problem.message, "detail": problem.detail},
        ) from problem

    document = parse_markdown(result.markdown, doc_id="screenshot", source_path=None)
    return {
        "markdown": result.markdown,
        "blocks": [b.model_dump() for b in document.blocks],
        # Surfaced, never buried: a transcription with holes must not be presented as
        # complete, and the student is the only one who can fill them in.
        "hasUnreadable": result.has_unreadable,
        "bytes": len(image),
    }


@router.post("/file")
async def ingest_file(request: Request, body: FileRequest) -> Snapshot:
    """Read a source file, parse it, and make it the open document.

    If a `<name>.ah.json` already sits beside it, that is opened instead of re-parsing —
    it is the user's edited work and the markdown is only its origin.
    """
    path = Path(body.path).expanduser()

    if not path.exists():
        raise _fail(404, "ingest.file-missing", f"There is no file at {path}.")
    if path.is_dir():
        raise _fail(400, "ingest.not-a-file", f"{path} is a directory, not a source file.")
    if path.suffix.lower() not in SOURCE_SUFFIXES and not path.name.endswith(".ah.json"):
        raise _fail(
            400,
            "ingest.unsupported-source",
            f"{path.name} has suffix {path.suffix!r}. Markdown ingest reads "
            + ", ".join(sorted(SOURCE_SUFFIXES))
            + ". Screenshot ingest is a separate path and is not built yet.",
        )

    size = path.stat().st_size
    if size > MAX_SOURCE_BYTES:
        raise _fail(
            413,
            "ingest.file-too-large",
            f"{path.name} is {size} bytes; the limit is {MAX_SOURCE_BYTES}. That is far "
            "larger than any homework file, so this is almost certainly the wrong path.",
        )

    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise _fail(
            400,
            "ingest.not-utf8",
            f"{path.name} is not UTF-8 text (byte {exc.start}: {exc.reason}). If it is a "
            "PDF or an image, that is a different ingest path and it is not built yet.",
        ) from exc
    except OSError as exc:
        raise _fail(
            500, "ingest.unreadable", f"Could not read {path}: {exc.strerror or exc}."
        ) from exc

    document_path = document_path_for(path)
    try:
        if document_path.exists() and document_path != path:
            store = FileDocumentStore.open(document_path)
        else:
            parsed = parse_markdown(text, doc_id=path.stem, source_path=str(path))
            store = FileDocumentStore.create(document_path, parsed)
    except DocumentTooNew as exc:
        # The refusal message names the .bak-v<n> file and the command to restore it.
        raise _fail(409, exc.code, exc.message) from exc
    except DocumentReadError as exc:
        raise _fail(422, exc.code, exc.message) from exc

    if not body.open_document:
        return store.snapshot()

    previous = get_document_store(request.app)
    if previous is not None:
        # Keep the live store object so existing subscribers (the WS fan-out) survive a
        # file swap instead of quietly going deaf.
        return previous.replace(store.snapshot().document, "file")

    set_document_store(request.app, store)
    return store.snapshot()
