"""Building what gets sent to Anthropic. Invariant I9, enforced at the TYPE LEVEL.

The claim in the README, stated precisely because the loose version is false:

  * The tracing sheet, the extracted glyph profile and the font are NEVER transmitted
    and never committed.
  * Rendered output is the user's document, and it is sent only when they ask a
    question about it.

The second bullet is why the loose phrasing ("handwriting never leaves the machine")
had to go: asking about a selection may carry an image crop of the rendered page, and
a rendered page is a picture of the user's hand.

The enforcement is structural rather than a code review rule: `ChatPayload` has **no
field through which a glyph profile could travel**. It accepts document text, layout
metrics and an image crop. There is no `profile`, no `glyphs`, no `font`, no
`**kwargs`, and `extra="forbid"` means constructing one with such a field raises.
"""

from __future__ import annotations

import base64

from pydantic import Base64Bytes, BaseModel, ConfigDict, Field

#  The ONLY host this application ever contacts. Asserted by a test that monkeypatches
#  the transport. No telemetry, no crash reporting, no font service.
ALLOWED_HOST = "api.anthropic.com"


class SelectionContext(BaseModel):
    """What the model is told about the selected passage.

    Layout metrics only — where it sits, how wide, which page. Never the glyph outlines
    that drew it.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    block_ids: list[str]
    text: str = Field(description="The plain text or LaTeX of the selection.")
    page_index: int = 0
    width_mm: float = 0.0
    height_mm: float = 0.0


class ChatPayload(BaseModel):
    """Everything that may leave the machine for a chat turn. Exhaustive by design."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    question: str
    selection: SelectionContext | None = None
    document_text: str = ""
    #  A PNG crop of the RENDERED PAGE. The user's own document, sent because they
    #  asked a question about it, never unprompted.
    #
    #  Base64Bytes, not bytes: the wire format is JSON, and a plain `bytes` field would
    #  read the base64 STRING as UTF-8 bytes and forward that to the model as a
    #  corrupt image — an error that produces a confident answer about nothing.
    image_crop_png: Base64Bytes | None = None

    def to_messages(self) -> list[dict]:
        content: list[dict] = []
        if self.image_crop_png:
            content.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": base64.b64encode(self.image_crop_png).decode("ascii"),
                    },
                }
            )
        parts: list[str] = []
        if self.selection:
            parts.append(f"Selected passage:\n{self.selection.text}")
        if self.document_text:
            parts.append(f"The wider document:\n{self.document_text}")
        parts.append(f"Question: {self.question}")
        content.append({"type": "text", "text": "\n\n".join(parts)})
        return [{"role": "user", "content": content}]
