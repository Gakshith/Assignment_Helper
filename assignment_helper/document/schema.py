"""The document model. FROZEN CONTRACT — changes go through the lead on `dev`.

The architecture is "the document is truth": render(Document, Style, seed) -> Page is
pure and deterministic. Nothing downstream of this module may invent state.

SEEDS LIVE ON BLOCKS, NOT ON THE PAGE. That is what makes editing one line leave the
rest of the page alone (invariant I3). A page-level seed would re-roll everything on
every edit.

This module owns: the block model, ops, versioning, serialisation, migrations.
It must not know about: rendering, canvas, fonts, the LLM, HTTP.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = 1


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


# ---------------------------------------------------------------- blocks


class ProseBlock(Strict):
    kind: Literal["prose"] = "prose"
    id: str
    seed: int
    text: str
    emphasis: Literal["normal", "heading", "answer"] = "normal"


class MathBlock(Strict):
    kind: Literal["math"] = "math"
    id: str
    seed: int
    latex: str
    display: bool = True


class DiagramBlock(Strict):
    kind: Literal["diagram"] = "diagram"
    id: str
    seed: int
    # Primitives only in v1: line, arrow, circle, rect, label, axis.
    spec: list[dict]
    height_mm: float = 40.0


class BoxedBlock(Strict):
    """A boxed final answer. Contains its own blocks so an answer can carry math."""

    kind: Literal["boxed"] = "boxed"
    id: str
    seed: int
    children: list[Block]


class SpacerBlock(Strict):
    kind: Literal["spacer"] = "spacer"
    id: str
    seed: int
    height_mm: float


Block = Annotated[
    ProseBlock | MathBlock | DiagramBlock | BoxedBlock | SpacerBlock,
    Field(discriminator="kind"),
]


# ---------------------------------------------------------------- style


class PaperStyle(Strict):
    kind: Literal["ruled", "plain", "grid", "rough"] = "ruled"
    ruling: Literal["college", "wide", "grid5"] = "college"
    page_size: Literal["letter", "a4", "legal"] = "letter"
    tint: str = "#F4F1E9"
    rule_colour: str = "#9FB6CC"
    margin_rule_colour: str = "#D08C8C"
    grain: float = Field(0.5, ge=0, le=1)
    aging: float = Field(0.15, ge=0, le=1)


class HandStyle(Strict):
    profile: str = "reference"          # "reference" until M2 builds a real profile
    ink_colour: str = "#1C2521"
    size_mm: float = 4.2               # x-height-ish nominal glyph size
    slant_deg: float = -4.0
    neatness: float = Field(0.5, ge=0, le=1)  # the master dial; 1 = clean
    # Advanced knobs detach from the master curve when touched (design §B.4).
    overrides: dict[str, float] = Field(default_factory=dict)


class Style(Strict):
    paper: PaperStyle = PaperStyle()
    hand: HandStyle = HandStyle()
    margins_mm: tuple[float, float, float, float] = (25.4, 19.0, 25.4, 31.75)
    preview_dpi: int = 150
    export_dpi: int = 200


# ---------------------------------------------------------------- document


class Document(Strict):
    schema_version: int = SCHEMA_VERSION
    id: str
    title: str = ""
    blocks: list[Block] = Field(default_factory=list)
    style: Style = Style()
    source_path: str | None = None


# ---------------------------------------------------------------- deltas

class InsertBlock(Strict):
    op: Literal["insert"] = "insert"
    index: int
    block: Block


class RemoveBlock(Strict):
    op: Literal["remove"] = "remove"
    block_id: str


class ReplaceBlock(Strict):
    op: Literal["replace"] = "replace"
    block_id: str
    block: Block


class SetStyle(Strict):
    op: Literal["style"] = "style"
    style: Style


Op = Annotated[InsertBlock | RemoveBlock | ReplaceBlock | SetStyle, Field(discriminator="op")]


class Delta(Strict):
    """Invariant I4: a delta whose parent_version != client version is REJECTED.

    Never merged blindly, never reconciled heuristically. The client asks for a
    full snapshot instead.
    """

    parent_version: int
    ops: list[Op]
    origin: Literal["user", "ai", "file", "server"] = "user"


class Snapshot(Strict):
    version: int
    document: Document


# ---------------------------------------------------------------- problems


class Problem(Strict):
    """Invariant I5: no silent failure. Every subsystem failure becomes one of these
    and reaches the UI — block scope renders a red badge, app scope a banner."""

    scope: Literal["block", "page", "app"]
    code: str
    message: str
    block_id: str | None = None
    detail: str | None = None


BoxedBlock.model_rebuild()
