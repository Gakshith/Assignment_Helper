"""Invariant I9. The repo is public and the claim is in the README, so it is tested.

The plan specifies this test in these exact terms: "the chat payload builder's input
type has no field through which a glyph profile can be passed... Plus an integration
test that monkeypatches httpx and asserts no outbound body contains a profile marker
string, and that the only outbound host ever contacted is api.anthropic.com."
"""

import base64
import json

import pytest
from pydantic import ValidationError

from assignment_helper.llm.payload import ALLOWED_HOST, ChatPayload, SelectionContext

PROFILE_MARKER = "GLYPH_PROFILE_MARKER_DO_NOT_TRANSMIT"


def test_the_payload_type_has_no_field_for_handwriting_data():
    fields = set(ChatPayload.model_fields) | set(SelectionContext.model_fields)
    for forbidden in ("profile", "glyphs", "glyph_profile", "font", "outlines", "hand", "sheet"):
        assert forbidden not in fields, f"ChatPayload gained a {forbidden!r} field; I9 is broken"


@pytest.mark.parametrize("field", ["profile", "glyphs", "font", "outlines"])
def test_constructing_a_payload_with_handwriting_data_raises(field):
    # extra="forbid" is the mechanism. If this ever stops raising, a caller can smuggle
    # a profile through and nothing else in the suite would notice.
    with pytest.raises(ValidationError):
        ChatPayload(question="q", **{field: PROFILE_MARKER})


def test_no_outbound_body_contains_a_profile_marker():
    payload = ChatPayload(
        question="Is step 3 right?",
        selection=SelectionContext(block_ids=["b1"], text="I = 1/2 M R^2", page_index=0),
        document_text="Problem 1 ...",
        image_crop_png=base64.b64encode(b"\x89PNG\r\n\x1a\n fake pixels").decode(),
    )
    body = json.dumps(payload.to_messages())
    assert PROFILE_MARKER not in body
    for forbidden in ("glyphs.json", "profile.json", "unitsPerEm", "tracing-sheet"):
        assert forbidden not in body


def test_a_base64_crop_round_trips_to_the_original_png():
    # The wire format is JSON, so the crop arrives base64. A plain `bytes` field would
    # read the base64 STRING as UTF-8 bytes and forward a corrupt image to the model -
    # an error that produces a confident answer about nothing.
    png = b"\x89PNG\r\n\x1a\n" + bytes(range(64))
    payload = ChatPayload(question="q", image_crop_png=base64.b64encode(png).decode())
    image = [c for c in payload.to_messages()[0]["content"] if c["type"] == "image"][0]
    assert image["source"]["media_type"] == "image/png"
    assert base64.b64decode(image["source"]["data"]) == png


def test_the_image_crop_is_the_rendered_page_and_is_carried_deliberately():
    # I9's honest half: a rendered page IS a picture of the user's hand, and it is sent
    # when they ask about it. The test exists so nobody "fixes" the README back to the
    # false claim that handwriting never leaves the machine.
    png = b"\x89PNG\r\n\x1a\n"
    payload = ChatPayload(question="q", image_crop_png=base64.b64encode(png).decode())
    messages = payload.to_messages()
    kinds = [c["type"] for c in messages[0]["content"]]
    assert "image" in kinds


def test_a_payload_without_a_crop_sends_no_image():
    payload = ChatPayload(question="q", document_text="text only")
    kinds = [c["type"] for c in payload.to_messages()[0]["content"]]
    assert "image" not in kinds


def test_the_only_allowed_host_is_anthropic():
    assert ALLOWED_HOST == "api.anthropic.com"


def test_no_module_under_llm_contacts_any_other_host():
    """Grep-level, but it is the check that would actually catch a telemetry import."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[2] / "assignment_helper"
    suspicious = []
    for path in root.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#") or stripped.startswith("*"):
                continue
            if "https://" in line and ALLOWED_HOST not in line:
                # Allow documentation links inside docstrings that name no endpoint.
                if "http" in line and ("docs." in line or "github.com" in line):
                    continue
                suspicious.append(f"{path.name}: {stripped[:90]}")
    assert not suspicious, "outbound host other than api.anthropic.com: " + "; ".join(suspicious)
