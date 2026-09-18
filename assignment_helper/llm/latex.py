"""Structural LaTeX validation, run at GENERATION time.

Plan §C.5.2 requires that emitted LaTeX be validated before it becomes a block, because
acceptance row 6 catches a parse failure at RENDER time — by which point the user is
looking at a red badge on a block that should never have existed.

**Where the authority lives, stated honestly.** KaTeX is JavaScript and the browser is
the only renderer (see CLAUDE.md), so the only *authoritative* parse is the browser's.
Python cannot import KaTeX. This module is therefore the CHEAP FIRST GATE: it catches
the failures a language model actually makes — unbalanced braces, a stray delimiter, an
unclosed environment, an empty mandatory argument — without claiming to be KaTeX.

The split, and nothing may blur it:
  * here, at generation: structural checks, one repair round trip with the error quoted
    back to the model.
  * in the browser, before the block is committed: `katex.__parse`, the real thing.

Calling this "validated" and skipping the browser step would reintroduce exactly the
late failure §C.5.2 exists to remove, so `validate()` returns a result that says which
checks it actually ran.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

PAIRS = {"{": "}", "[": "]"}
CLOSERS = {v: k for k, v in PAIRS.items()}

#  Commands whose first mandatory argument must not be empty. \frac{}{2} parses in some
#  engines and renders as a hole; it is never what was meant.
NEEDS_ARG = ("frac", "sqrt", "text", "mathrm", "overline", "underline", "hat", "vec")

_ENV_OPEN = re.compile(r"\\begin\{([^}]*)\}")
_ENV_CLOSE = re.compile(r"\\end\{([^}]*)\}")


@dataclass
class LatexResult:
    ok: bool
    errors: list[str] = field(default_factory=list)
    #  Named so a caller can never mistake this for a KaTeX parse.
    checks_run: tuple[str, ...] = (
        "delimiters-stripped",
        "brace-balance",
        "environment-balance",
        "empty-mandatory-argument",
        "non-empty",
    )
    authoritative: bool = False  # always False here; only the browser's parse is


def _strip_delimiters(tex: str) -> tuple[str, list[str]]:
    """The model is told not to include $ delimiters. It sometimes does anyway."""
    errors: list[str] = []
    t = tex.strip()
    for delim in ("$$", "\\[", "\\]", "\\(", "\\)", "$"):
        if delim in t:
            errors.append(
                f"contains the math delimiter {delim!r}; the block already knows it is math"
            )
            t = t.replace(delim, "")
    return t, errors


def validate(tex: str) -> LatexResult:
    errors: list[str] = []
    stripped, delim_errors = _strip_delimiters(tex)
    errors.extend(delim_errors)

    if not stripped.strip():
        errors.append("empty after stripping delimiters")
        return LatexResult(False, errors)

    # Brace and bracket balance, ignoring escaped \{ and \[.
    stack: list[str] = []
    i = 0
    while i < len(stripped):
        ch = stripped[i]
        if ch == "\\":
            i += 2
            continue
        if ch in PAIRS:
            stack.append(ch)
        elif ch in CLOSERS:
            if not stack:
                errors.append(f"unmatched {ch!r} at offset {i}")
            elif stack[-1] != CLOSERS[ch]:
                errors.append(f"mismatched {stack[-1]!r} closed by {ch!r} at offset {i}")
                stack.pop()
            else:
                stack.pop()
        i += 1
    if stack:
        errors.append(f"unclosed {''.join(stack)!r}")

    opened = _ENV_OPEN.findall(stripped)
    closed = _ENV_CLOSE.findall(stripped)
    if opened != closed:
        errors.append(f"environment mismatch: begin{opened} vs end{closed}")

    for cmd in NEEDS_ARG:
        if re.search(rf"\\{cmd}\s*\{{\s*\}}", stripped):
            errors.append(rf"\{cmd} has an empty mandatory argument")

    return LatexResult(not errors, errors)


def repair_prompt(tex: str, result: LatexResult) -> str:
    """What to send back to the model for its ONE repair attempt (row 19)."""
    problems = "\n".join(f"  - {e}" for e in result.errors)
    return (
        "The LaTeX you produced did not pass validation:\n"
        f"{problems}\n\n"
        f"Source:\n{tex}\n\n"
        "Return only the corrected LaTeX, with no $ delimiters and no commentary."
    )
