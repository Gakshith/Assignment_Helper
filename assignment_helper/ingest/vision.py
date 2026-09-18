"""Screenshot -> Document. The Tier 3 ingest path.

Platform integrations are tiered, and the tiering is a decision rather than a
limitation. Tier 1 is an official API (Canvas only). **Tier 2 — browser automation and
scraping — is deliberately not built**: Gradescope's terms prohibit it and Expert TA has
no content API at all. Tier 3 is what is left and what most courses actually need:
the student screenshots the assignment, and the PDF goes back by hand.

So this is the front door for every platform we will never integrate with, and it has
to be good rather than a fallback.

**It produces MARKDOWN, not blocks.** The markdown parser already turns text into a
Document, with inline maths splitting a paragraph in reading order, fenced code left
alone and stable block ids. Having the model emit blocks directly would be a second,
worse parser that drifts from the first — and the first is the one every other input
path uses.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

from assignment_helper.llm.client import LLMClient, LLMProblem

#: What the model is told to produce. Markdown, because parse_markdown is the one path.
VISION_SYSTEM = """\
You are reading a screenshot or photograph of a problem set.

Return ONLY the problems, transcribed as markdown. No preamble, no commentary, no
answers — you are transcribing, not solving.

Rules:
- Each problem becomes a `## Problem N` heading followed by its text.
- Mathematics becomes LaTeX: `$...$` inline, `$$...$$` for a displayed equation.
- Transcribe numbers and units EXACTLY as printed. A misread exponent or a dropped
  unit turns into a wrong answer three steps later, and nothing downstream will catch
  it.
- If part of the image is unreadable, write `[UNREADABLE]` in place of that text
  rather than guessing at it. A guess that looks like a problem statement is far worse
  than a marker the student can see and fix.
- Ignore page furniture: headers, footers, page numbers, the course name, due dates.
"""

SUPPORTED_MEDIA = {
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"\xff\xd8\xff": "image/jpeg",
    b"GIF87a": "image/gif",
    b"GIF89a": "image/gif",
    b"RIFF": "image/webp",
}

MAX_IMAGE_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class Transcription:
    markdown: str
    #: True when the model marked anything unreadable. The UI must not present a
    #: transcription with holes in it as if it were complete.
    has_unreadable: bool


def sniff_media_type(data: bytes) -> str:
    """Media type from the MAGIC BYTES, never from a filename.

    A `.png` that is actually a JPEG is common (screenshot tools rename freely), and
    the API rejects a mismatch with an error about the image rather than about the
    name, which sends the user hunting in the wrong place.
    """
    for magic, media in SUPPORTED_MEDIA.items():
        if data.startswith(magic):
            return media
    raise LLMProblem(
        "ingest.unsupported-image",
        "That file is not a PNG, JPEG, GIF or WebP.",
        detail=f"first bytes: {data[:8]!r}",
    )


def transcribe(client: LLMClient, image: bytes, *, hint: str = "") -> Transcription:
    """One image -> markdown. Raises a named LLMProblem; never returns a partial guess."""
    if not image:
        raise LLMProblem("ingest.empty-image", "The uploaded image is empty.")
    if len(image) > MAX_IMAGE_BYTES:
        raise LLMProblem(
            "ingest.image-too-large",
            f"That image is {len(image) / 1024 / 1024:.1f} MB; the limit is "
            f"{MAX_IMAGE_BYTES / 1024 / 1024:.0f} MB. Screenshot the page rather than "
            "photographing the whole screen.",
        )

    media_type = sniff_media_type(image)
    content: list[dict] = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": base64.b64encode(image).decode("ascii"),
            },
        },
        {
            "type": "text",
            "text": hint or "Transcribe the problems in this image as markdown.",
        },
    ]

    chunks: list[str] = []
    for event in client.stream(
        system=VISION_SYSTEM,
        messages=[{"role": "user", "content": content}],
        max_tokens=8000,
    ):
        if event.kind == "text":
            chunks.append(event.text)

    markdown = "".join(chunks).strip()
    if not markdown:
        raise LLMProblem(
            "ingest.empty-transcription",
            "The model returned nothing for that image. Nothing was added to your document.",
        )

    return Transcription(markdown=markdown, has_unreadable="[UNREADABLE]" in markdown)
