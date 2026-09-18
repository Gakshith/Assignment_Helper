"""A problem set -> an ordered block sequence. Plan §C.5.2.

The five things §C.5.2 required, and where each one lives:

1. **How a problem set becomes an ordered block sequence** — `solution_to_blocks`, below.
2. **How emitted LaTeX is validated at generation time** — `validate_solution`, which
   runs `llm.latex.validate` BEFORE any block exists, so a parse failure never reaches
   the page as a red badge on a block that should not have been created.
3. **How a multi-step derivation maps to blocks** — one block per step, never merged.
   The block is the unit of selection, editing, chat and re-roll; a derivation collapsed
   into one block is uneditable in exactly the way the product promises it is editable.
4. **How the prompt is constrained to the document schema** — `prompts.SOLVER_SYSTEM`
   plus `schemas.SolutionSet`. Prompt as guidance, schema as gate.
5. **What happens when the answer is simply wrong** — nothing downstream re-checks it,
   and there is no loop back to re-solve. The only honest mechanism is to make the
   model's own doubt visible BEFORE the student hands the page in, so a non-high
   confidence emits a real, visible note block and `review_required` is set.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from assignment_helper.document.schema import (
    Block,
    BoxedBlock,
    MathBlock,
    ProseBlock,
    SpacerBlock,
)
from assignment_helper.ingest.markdown import seed_for_block
from assignment_helper.llm.latex import LatexResult, validate
from assignment_helper.llm.schemas import SolutionSet, SolvedProblem


@dataclass
class ValidationReport:
    ok: bool
    #  (problem number, where, result) — quoted back to the model for its one repair.
    failures: list[tuple[str, str, LatexResult]] = field(default_factory=list)

    def summary(self) -> str:
        return "; ".join(f"{n} {where}: {', '.join(r.errors)}" for n, where, r in self.failures)


def validate_solution(solution: SolutionSet) -> ValidationReport:
    """Run the cheap structural gate over every piece of LaTeX before any block exists.

    This is NOT a KaTeX parse — KaTeX is JavaScript and the browser is the only
    renderer. See `llm/latex.py`: the authoritative parse happens in the browser before
    the block is committed. This catches what a model actually gets wrong.
    """
    failures: list[tuple[str, str, LatexResult]] = []
    for p in solution.problems:
        for i, step in enumerate(p.steps):
            if step.latex:
                r = validate(step.latex)
                if not r.ok:
                    failures.append((p.number, f"step {i + 1}", r))
        if p.answer_latex:
            r = validate(p.answer_latex)
            if not r.ok:
                failures.append((p.number, "answer", r))
    return ValidationReport(not failures, failures)


def _block_id(problem: str, part: str, index: int) -> str:
    return f"s-{problem}-{part}-{index}"


def _prose(problem: str, part: str, index: int, text: str, emphasis: str = "normal") -> ProseBlock:
    bid = _block_id(problem, part, index)
    return ProseBlock(id=bid, seed=seed_for_block(bid), text=text, emphasis=emphasis)


def _math(problem: str, part: str, index: int, latex: str) -> MathBlock:
    bid = _block_id(problem, part, index)
    return MathBlock(id=bid, seed=seed_for_block(bid), latex=latex, display=True)


def problem_to_blocks(p: SolvedProblem) -> list[Block]:
    blocks: list[Block] = [
        _prose(p.number, "head", 0, f"{p.number}.", emphasis="heading"),
        _prose(p.number, "restate", 0, p.restatement),
    ]

    for i, step in enumerate(p.steps):
        blocks.append(_prose(p.number, "step", i, step.prose))
        if step.latex:
            blocks.append(_math(p.number, "eq", i, step.latex))

    if p.answer_latex or p.answer_prose:
        aid = _block_id(p.number, "answer", 0)
        children: list[Block] = []
        if p.answer_prose:
            children.append(_prose(p.number, "answerprose", 0, p.answer_prose))
        if p.answer_latex:
            children.append(_math(p.number, "answermath", 0, p.answer_latex))
        blocks.append(BoxedBlock(id=aid, seed=seed_for_block(aid), children=children))

    if p.confidence != "high":
        #  §C.5.2's fifth question. This block is DELIBERATELY part of the document and
        #  deliberately ugly to leave in: the student must either verify the step or
        #  delete the note, and either way they have seen it. A silent confidence field
        #  on an object nobody renders would be worth nothing at the moment it matters.
        note = p.uncertainty or "the model was not confident in this answer"
        blocks.append(
            _prose(p.number, "check", 0, f"[CHECK THIS — {note}]", emphasis="answer")
        )

    sid = _block_id(p.number, "gap", 0)
    blocks.append(SpacerBlock(id=sid, seed=seed_for_block(sid), height_mm=6.0))
    return blocks


@dataclass
class SolutionBlocks:
    blocks: list[Block]
    #  True when any problem came back below high confidence. The UI must not present
    #  the page as finished while this is set.
    review_required: bool
    low_confidence: list[str]


def solution_to_blocks(solution: SolutionSet) -> SolutionBlocks:
    blocks: list[Block] = []
    low: list[str] = []
    for p in solution.problems:
        blocks.extend(problem_to_blocks(p))
        if p.confidence != "high":
            low.append(p.number)
    return SolutionBlocks(blocks=blocks, review_required=bool(low), low_confidence=low)
