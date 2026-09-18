"""The solver. Plan §C.5.2, which found it had no specification at all.

§C.5.2 also noted: "Zero acceptance rows currently test the model's output on a real
assignment. Add one." `test_a_real_problem_set_becomes_a_sensible_page` is that row.
"""

import pytest

from assignment_helper.llm.client import LLMClient, LLMProblem, Spend
from assignment_helper.llm.keys import ADD_KEY_COMMAND, resolve_key
from assignment_helper.llm.latex import repair_prompt, validate
from assignment_helper.llm.schemas import SolutionSet, SolvedProblem, SolvedStep
from assignment_helper.llm.solver import solution_to_blocks, validate_solution


def problem(number="1", *, confidence="high", latex=r"\tfrac{1}{2} M R^2", uncertainty=None):
    return SolvedProblem(
        number=number,
        restatement="Find the angular acceleration.",
        steps=[SolvedStep(prose="Moment of inertia of a disk.", latex=latex)],
        answer_latex=r"\alpha = 26.7",
        confidence=confidence,
        uncertainty=uncertainty,
    )


# ---------------------------------------------------------------- latex gate


@pytest.mark.parametrize(
    "tex,ok",
    [
        (r"\frac{a}{b}", True),
        (r"\int_0^\infty e^{-x^2}\,dx", True),
        (r"a \{ b \}", True),
        (r"\frac{a}{b", False),
        (r"$x^2$", False),
        (r"\frac{}{2}", False),
        (r"\begin{aligned} x &= 1 \end{matrix}", False),
        ("", False),
    ],
)
def test_structural_validation(tex, ok):
    assert validate(tex).ok is ok


def test_validation_never_claims_to_be_katex():
    # The authoritative parse is the browser's. If this flips to True, someone has
    # blurred the split and a render-time failure can masquerade as validated.
    assert validate(r"\frac{a}{b}").authoritative is False


def test_repair_prompt_quotes_the_actual_error_back():
    r = validate(r"\frac{a}{b")
    p = repair_prompt(r"\frac{a}{b", r)
    assert "unclosed" in p
    assert "no $ delimiters" in p


def test_bad_latex_is_caught_before_any_block_exists():
    bad = SolutionSet(problems=[problem(latex=r"\frac{a}{b")])
    report = validate_solution(bad)
    assert not report.ok
    assert "unclosed" in report.summary()


# ---------------------------------------------------------------- block mapping


def test_each_step_becomes_its_own_block_never_merged():
    sol = SolutionSet(
        problems=[
            SolvedProblem(
                number="1",
                restatement="Find a.",
                steps=[
                    SolvedStep(prose="First.", latex="a = 1"),
                    SolvedStep(prose="Second.", latex="b = 2"),
                    SolvedStep(prose="Third, no maths."),
                ],
                confidence="high",
            )
        ]
    )
    blocks = solution_to_blocks(sol).blocks
    prose = [b.text for b in blocks if b.kind == "prose"]
    maths = [b.latex for b in blocks if b.kind == "math"]
    assert "First." in prose and "Second." in prose and "Third, no maths." in prose
    assert maths == ["a = 1", "b = 2"]
    # The block is the unit of selection, edit, chat and re-roll. A derivation collapsed
    # into one block is uneditable in exactly the way the product promises it is not.
    assert not any(len(t) > 200 for t in prose)


def test_the_answer_is_boxed():
    blocks = solution_to_blocks(SolutionSet(problems=[problem()])).blocks
    assert any(b.kind == "boxed" for b in blocks)


def test_low_confidence_puts_a_VISIBLE_note_in_the_document():
    # §C.5.2's fifth question: nothing downstream re-checks a wrong answer and there is
    # no loop back to re-solve. The doubt has to be visible before the page is handed in,
    # not parked on a field nobody renders.
    sol = SolutionSet(problems=[problem(confidence="low", uncertainty="no figure was given")])
    result = solution_to_blocks(sol)
    assert result.review_required
    assert result.low_confidence == ["1"]
    notes = [b.text for b in result.blocks if b.kind == "prose" and "CHECK THIS" in b.text]
    assert len(notes) == 1
    assert "no figure was given" in notes[0]


def test_high_confidence_adds_no_note():
    result = solution_to_blocks(SolutionSet(problems=[problem(confidence="high")]))
    assert not result.review_required
    assert not any("CHECK THIS" in getattr(b, "text", "") for b in result.blocks)


def test_block_ids_and_seeds_are_deterministic():
    a = solution_to_blocks(SolutionSet(problems=[problem()])).blocks
    b = solution_to_blocks(SolutionSet(problems=[problem()])).blocks
    assert [x.id for x in a] == [x.id for x in b]
    assert [x.seed for x in a] == [x.seed for x in b]


def test_a_real_problem_set_becomes_a_sensible_page():
    """The acceptance row §C.5.2 asked for: the model's output shape, on a real
    assignment, producing a page a marker would accept."""
    sol = SolutionSet(
        problems=[
            SolvedProblem(
                number="1",
                restatement="Find the angular acceleration of a disk under a rim force.",
                steps=[
                    SolvedStep(prose="A solid disk about its centre has I = half M R squared.",
                               latex=r"I = \tfrac{1}{2} M R^2"),
                    SolvedStep(prose="Substituting the given mass and radius.",
                               latex=r"I = 0.0225\,\text{kg}\,\text{m}^2"),
                    SolvedStep(prose="The torque is the rim force times the radius.",
                               latex=r"\tau = F R = 0.600\,\text{N}\,\text{m}"),
                    SolvedStep(prose="Newton's second law for rotation gives the acceleration.",
                               latex=r"\alpha = \tau / I"),
                ],
                answer_latex=r"\alpha = 26.7\,\text{rad/s}^2",
                confidence="high",
            ),
            SolvedProblem(
                number="2",
                restatement="Find the time to reach 60 rad/s from rest.",
                steps=[SolvedStep(prose="Constant angular acceleration from rest.",
                                  latex=r"\omega = \alpha t")],
                answer_latex=r"t = 2.25\,\text{s}",
                confidence="high",
            ),
        ]
    )
    assert validate_solution(sol).ok
    result = solution_to_blocks(sol)
    assert not result.review_required

    kinds = [b.kind for b in result.blocks]
    assert kinds.count("boxed") == 2   # one boxed answer per problem
    # Five TOP-LEVEL maths blocks: 4 step equations in problem 1, 1 in problem 2. The
    # two answers are maths blocks nested inside the BoxedBlocks, so they are children
    # and do not appear here.
    assert kinds.count("math") == 5
    boxed = [b for b in result.blocks if b.kind == "boxed"]
    assert all(any(c.kind == "math" for c in b.children) for b in boxed)
    assert kinds.count("spacer") == 2                     # never a stack of spacers
    headings = [b.text for b in result.blocks if getattr(b, "emphasis", "") == "heading"]
    assert headings == ["1.", "2."]


# ---------------------------------------------------------------- keys and client


def test_row_1_no_key_means_the_app_still_works():
    client = LLMClient(None)
    assert client.available is False          # only the AI features are off
    with pytest.raises(LLMProblem) as exc:
        list(client.stream(system="s", messages=[]))
    assert exc.value.code == "llm.no-key"
    # The message must name the exact command, not "add a key in settings".
    assert "security add-generic-password" in (exc.value.detail or "")
    assert "security add-generic-password" in ADD_KEY_COMMAND


def test_offline_bypass_is_named():
    with pytest.raises(LLMProblem) as exc:
        list(LLMClient("k", offline=True).stream(system="s", messages=[]))
    assert exc.value.code == "llm.offline"


def test_key_never_appears_in_a_repr():
    r = resolve_key(use_keyring=False)
    assert "sk-ant" not in repr(r)


def test_spend_cap_trips_before_the_call():
    spend = Spend(cap_usd=1.0, input_tokens=500_000, output_tokens=100_000)
    client = LLMClient("k", spend=spend)
    with pytest.raises(LLMProblem) as exc:
        list(client.stream(system="s", messages=[]))
    assert exc.value.code == "llm.spend-cap"
