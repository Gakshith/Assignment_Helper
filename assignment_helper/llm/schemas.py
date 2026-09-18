"""The structured shapes the model is allowed to return.

Plan §C.5.2 required a real specification for the solver. The load-bearing decision is
this one:

> **Emitted LaTeX is validated at GENERATION time, not at render time.**

Acceptance row 6 catches a KaTeX parse failure when the page renders, which is far too
late: the user sees a red badge on a block that should never have been created. The
model is asked again, once, with the parse error quoted back to it. Only then does a
bad block reach the document, and it is marked.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SolvedStep(Strict):
    """One step of a derivation.

    A multi-step derivation maps to an ORDERED SEQUENCE of these, and each becomes one
    or two document blocks: the prose line, then the display math it refers to. Steps
    are never merged into one block — the whole editing model (select a line, ask about
    it, re-roll it) works at block granularity, so a derivation collapsed into a single
    block cannot be edited the way the product promises.
    """

    prose: str = Field(description="One sentence of reasoning. Plain text, no LaTeX delimiters.")
    latex: str | None = Field(
        default=None,
        description="The display equation for this step, LaTeX only, without $ delimiters.",
    )


class SolvedProblem(Strict):
    number: str = Field(description="The problem's label as it appears in the source, e.g. '1' or '2a'.")
    restatement: str = Field(description="One line restating what is being found. No preamble.")
    steps: list[SolvedStep]
    answer_latex: str | None = Field(
        default=None, description="The final answer as LaTeX, boxed in the rendered page."
    )
    answer_prose: str | None = Field(
        default=None, description="The final answer in words, when it is not an equation."
    )
    #  §C.5.2 asked what happens when the answer is simply WRONG. It is not a
    #  block-editing problem and there is no loop back to re-solve, so the only honest
    #  mechanism available is to make the model's own doubt visible to the user.
    confidence: Literal["high", "medium", "low"] = Field(
        description=(
            "low when the problem is ambiguous, under-specified, or depends on a figure "
            "that was not provided. Prefer low over a confident guess."
        )
    )
    uncertainty: str | None = Field(
        default=None,
        description="When confidence is not high, one line naming exactly what is uncertain.",
    )


class SolutionSet(Strict):
    problems: list[SolvedProblem]


class BlockEdit(Strict):
    """An edit the model proposes to ONE existing block.

    Acceptance row 19: schema-validate before applying, one repair round trip, and on a
    second failure show the raw response and apply NOTHING. Every AI edit is one undo
    step.
    """

    block_id: str
    kind: Literal["prose", "math"]
    text: str = Field(description="New prose text, or LaTeX for a math block. No delimiters.")
    rationale: str = Field(description="One line. Shown to the user before they accept.")
