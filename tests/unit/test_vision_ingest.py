"""Tier 3 ingest: a screenshot of the assignment becomes a Document.

Tier 2 — browser automation and scraping — is deliberately not built (Gradescope's
terms prohibit it, Expert TA has no content API), so this is the front door for every
platform the product will never integrate with. It has to be good rather than a
fallback.
"""

from __future__ import annotations

import pytest

from assignment_helper.ingest.markdown import parse_markdown
from assignment_helper.ingest.vision import (
    MAX_IMAGE_BYTES,
    VISION_SYSTEM,
    sniff_media_type,
    transcribe,
)
from assignment_helper.llm.client import LLMProblem, StreamEvent

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


class FakeClient:
    """Streams a canned transcription. The point is the surrounding contract, not the
    model: what gets sent, what comes back, and what happens when it is empty."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.seen: list[dict] = []

    def stream(self, *, system: str, messages: list[dict], max_tokens: int = 0):
        self.seen = messages
        self.system = system
        yield StreamEvent("text", self.text)


def test_media_type_comes_from_magic_bytes_not_a_filename():
    # A .png that is actually a JPEG is common — screenshot tools rename freely — and
    # the API rejects a mismatch with an error about the IMAGE, which sends the user
    # hunting in the wrong place.
    assert sniff_media_type(b"\x89PNG\r\n\x1a\n...") == "image/png"
    assert sniff_media_type(b"\xff\xd8\xff\xe0...") == "image/jpeg"
    assert sniff_media_type(b"GIF89a...") == "image/gif"
    assert sniff_media_type(b"RIFF....WEBP") == "image/webp"


def test_an_unsupported_file_is_named_not_guessed():
    with pytest.raises(LLMProblem) as exc:
        sniff_media_type(b"%PDF-1.7")
    assert exc.value.code == "ingest.unsupported-image"


def test_an_empty_image_is_refused_before_any_api_call():
    client = FakeClient("unused")
    with pytest.raises(LLMProblem) as exc:
        transcribe(client, b"")
    assert exc.value.code == "ingest.empty-image"
    assert client.seen == [], "no request should have been made"


def test_an_oversized_image_is_refused_with_advice():
    client = FakeClient("unused")
    with pytest.raises(LLMProblem) as exc:
        transcribe(client, b"\x89PNG\r\n\x1a\n" + b"\x00" * MAX_IMAGE_BYTES)
    assert exc.value.code == "ingest.image-too-large"
    # The message tells the user what to do differently, not just that it failed.
    assert "Screenshot the page" in exc.value.message


def test_the_image_travels_as_base64_with_the_sniffed_media_type():
    client = FakeClient("## Problem 1\n\nFind $x$.")
    transcribe(client, PNG)
    content = client.seen[0]["content"]
    image = next(c for c in content if c["type"] == "image")
    assert image["source"]["type"] == "base64"
    assert image["source"]["media_type"] == "image/png"


def test_the_prompt_forbids_solving_and_forbids_guessing():
    # Two failure modes that both produce plausible output: answering instead of
    # transcribing, and inventing text for an unreadable patch.
    assert "transcribing, not solving" in VISION_SYSTEM
    assert "[UNREADABLE]" in VISION_SYSTEM
    assert "EXACTLY as printed" in VISION_SYSTEM


def test_an_empty_transcription_is_an_error_not_an_empty_document():
    # An empty Document would look like a successful ingest of a blank page.
    client = FakeClient("   ")
    with pytest.raises(LLMProblem) as exc:
        transcribe(client, PNG)
    assert exc.value.code == "ingest.empty-transcription"
    assert "Nothing was added" in exc.value.message


def test_unreadable_patches_are_flagged_so_the_ui_cannot_present_them_as_complete():
    client = FakeClient("## Problem 1\n\nA block of mass [UNREADABLE] kg slides.")
    result = transcribe(client, PNG)
    assert result.has_unreadable is True

    clean = FakeClient("## Problem 1\n\nA block of mass 2.4 kg slides.")
    assert transcribe(clean, PNG).has_unreadable is False


def test_the_transcription_goes_through_the_ONE_markdown_parser():
    # Not a second, worse parser that drifts from the first. Inline maths must split
    # the paragraph in reading order exactly as it does for a file on disk.
    client = FakeClient("## Problem 1\n\nA block of mass $m = 2.4$ kg slides down.")
    result = transcribe(client, PNG)
    doc = parse_markdown(result.markdown, doc_id="shot", source_path=None)
    kinds = [b.kind for b in doc.blocks]
    assert "math" in kinds
    assert kinds.count("prose") >= 2, "prose either side of the inline maths"
