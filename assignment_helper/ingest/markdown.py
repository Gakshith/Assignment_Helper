r"""markdown -> Document, and back again.

`assignment-helper hw7.md` is the product's simplest and most-used input path, so this
module is the one the renderer is actually exercised against. It is stdlib only: no
markdown library, and deliberately NOT a pile of regexes run over the whole file at
once, which is how nested structures get silently mangled. The file is scanned line by
line into UNITS (fence / heading / quote / paragraph / blank run) and only then are
units turned into blocks. Inline scanning happens inside a unit and never across one.


WHAT IS SUPPORTED
-----------------
  ATX headings `#`..`######`   -> ProseBlock(emphasis="heading"). The LEVEL IS LOST:
                                  the frozen block model has no heading level, so
                                  `###` and `#` render the same and re-serialise as `#`.
  paragraphs                   -> ProseBlock(emphasis="normal")
  `$...$`                      -> MathBlock(display=False)
  `$$...$$`                    -> MathBlock(display=True)
  `\$`                         -> a literal dollar sign in prose, never a delimiter
  fenced code ``` or ~~~       -> ProseBlock, VERBATIM, fences included, and never
                                  scanned for `$` (a `$` in a fence is a shell prompt)
  `> ` blockquote              -> BoxedBlock, its contents parsed recursively
  `**Answer:** ...` paragraph  -> ProseBlock(emphasis="answer")
  a run of 2+ blank lines      -> exactly one SpacerBlock, never a stack

THE BOXED/ANSWER MAPPING, stated once so it is consistent everywhere: a BLOCKQUOTE is
the boxed block. `**Answer:**` (also `**Final Answer:**`, `**Ans:**`, case-insensitive)
is NOT a box; it is `emphasis="answer"`, which is what that field in the frozen schema
exists for. Both appear in real homework and they mean different things — a box is a
drawn rectangle, an answer is emphasised prose — so they map to different blocks.

INLINE MATH SPLITS A PARAGRAPH and the surrounding prose is KEPT. "Given $v_0$ we get"
becomes prose("Given"), math("v_0", inline), prose("we get") in reading order. Throwing
the prose away is the classic version of this bug.

WHAT IS NOT SUPPORTED, honestly
-------------------------------
Emitted verbatim as prose, not silently restructured and not an error:
  * lists (`-`, `*`, `1.`) — the whole list arrives as one prose block, bullets included
  * tables, setext headings (`===` underlines), horizontal rules, indented code blocks
  * inline emphasis `*x*`, `**x**`, links, images, inline code spans — the markers stay
    in the text and will be rendered literally in handwriting
  * HTML
  * reference links and footnotes
A `$` with no closing `$` before the end of its paragraph is a literal dollar, not the
start of unterminated math. `$$` with nothing between it is a literal `$$`.
Blockquote nesting is followed to depth 16; below that the remaining `> ` prefixes are
kept as prose text. Nothing here raises on odd input — bad markdown produces literal
prose, which is visible on the page, rather than a dropped line, which is not.


BLOCK IDS ARE CONTENT-DERIVED AND STABLE
----------------------------------------
`id = <kind prefix>-<sha256(kind, content)[:12]>-<occurrence>`. Two reasons, both about
invariant I3 (block isolation):

  1. Seeds are derived from ids and seeds live on blocks. If ids were positional
     (`block-0`, `block-1`) or random, editing line 1 of a file and re-parsing would
     change every id below it, hence every seed, hence re-roll the handwriting of the
     entire page. Content-derived ids mean an untouched paragraph keeps its id, its
     seed and its exact ink.
  2. The occurrence counter is what makes that safe: two identical paragraphs hash the
     same, so they get `-0` and `-1`. Still deterministic, still identical on every
     machine and every run, but unique — and ops address blocks by id.

SEEDS come from `assignment_helper.rng`, the counter-based PRNG (I14), via
`seed_for_block(id)`. Pure integer arithmetic, so the same document renders identically
on any machine and any Python build. Seeds are on blocks; there is no page seed.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

from assignment_helper.document.schema import (
    Block,
    BoxedBlock,
    DiagramBlock,
    Document,
    MathBlock,
    ProseBlock,
    SpacerBlock,
)
from assignment_helper.rng import fnv1a64, splitmix64

__all__ = [
    "MarkdownSerialiseError",
    "SPACER_HEIGHT_MM",
    "document_to_markdown",
    "parse_markdown",
    "seed_for_block",
]

SPACER_HEIGHT_MM = 6.0
MAX_QUOTE_DEPTH = 16

_FENCE_RE = re.compile(r"^ {0,3}(?P<fence>`{3,}|~{3,})(?P<info>.*)$")
_HEADING_RE = re.compile(r"^ {0,3}(?P<hashes>#{1,6})(?:[ \t]+(?P<text>.*?))?[ \t]*$")
_QUOTE_RE = re.compile(r"^ {0,3}>[ \t]?(?P<text>.*)$")
_ANSWER_RE = re.compile(
    r"^\*\*[ \t]*(?:final[ \t]+answer|answer|ans)[ \t]*:?[ \t]*\*\*[ \t]*:?[ \t]*(?P<rest>.*)$",
    re.IGNORECASE | re.DOTALL,
)
_ANSWER_PREFIX = "**Answer:** "
_FENCE_MARKERS = ("```", "~~~")


class MarkdownSerialiseError(Exception):
    """A block has no markdown representation. Named, never a silent drop."""


def seed_for_block(block_id: str) -> int:
    """Derive a 64-bit block seed from a block id, using the I14 primitives.

    FNV-1a folds the id to 64 bits; splitmix64 decorrelates it, so ids that differ by
    one character do not produce neighbouring seeds. Deterministic and machine
    independent — no `hash()`, which is salted per process.
    """
    return splitmix64(fnv1a64(block_id))


# ------------------------------------------------------------------ ids


@dataclass
class _Ctx:
    """Per-document id bookkeeping. Shared with recursive blockquote parses so ids
    stay unique across the whole tree."""

    seen: dict[str, int] = field(default_factory=dict)

    def new_id(self, prefix: str, kind: str, payload: str) -> str:
        digest = hashlib.sha256(f"{kind}\x00{payload}".encode()).hexdigest()[:12]
        occurrence = self.seen.get(digest, 0)
        self.seen[digest] = occurrence + 1
        return f"{prefix}-{digest}-{occurrence}"


def _prose(ctx: _Ctx, text: str, emphasis: str) -> ProseBlock:
    block_id = ctx.new_id("p", "prose", f"{emphasis}\x00{text}")
    return ProseBlock(id=block_id, seed=seed_for_block(block_id), text=text, emphasis=emphasis)


def _math(ctx: _Ctx, latex: str, display: bool) -> MathBlock:
    block_id = ctx.new_id("m", "math", f"{int(display)}\x00{latex}")
    return MathBlock(id=block_id, seed=seed_for_block(block_id), latex=latex, display=display)


def _spacer(ctx: _Ctx) -> SpacerBlock:
    block_id = ctx.new_id("s", "spacer", f"{SPACER_HEIGHT_MM}")
    return SpacerBlock(id=block_id, seed=seed_for_block(block_id), height_mm=SPACER_HEIGHT_MM)


def _boxed(ctx: _Ctx, children: list[Block]) -> BoxedBlock:
    block_id = ctx.new_id("x", "boxed", "\x00".join(child.id for child in children))
    return BoxedBlock(id=block_id, seed=seed_for_block(block_id), children=children)


# ------------------------------------------------------------------ inline scan


def _find_close(text: str, start: int, delim: str) -> int | None:
    """Index of the next unescaped `delim` at or after `start`, or None."""
    i = start
    n = len(text)
    while i < n:
        if text[i] == "\\":
            i += 2
            continue
        if text.startswith(delim, i):
            return i
        i += 1
    return None


def _trailing_backslashes(text: str) -> int:
    count = 0
    while count < len(text) and text[len(text) - 1 - count] == "\\":
        count += 1
    return count


def _inline_blocks(ctx: _Ctx, text: str, emphasis: str) -> list[Block]:
    """Split one unit's text into prose/math blocks in reading order.

    Prose pieces keep `emphasis`; math pieces become MathBlocks. `\\$` becomes a literal
    `$` in the prose text. An unmatched delimiter is literal text, never an error and
    never a swallowed remainder.

    A normal prose piece that begins with `**Answer:**` is promoted to
    `emphasis="answer"` and the marker is dropped. The promotion lives here rather than
    at the unit level so that it also catches the piece after an inline math split
    ("$x$ **Answer:** 4"), which is what keeps the round trip a fixpoint.
    """
    blocks: list[Block] = []
    buffer: list[str] = []
    i = 0
    n = len(text)

    def flush() -> None:
        raw = "".join(buffer).strip()
        buffer.clear()
        if not raw:
            return
        piece_emphasis = emphasis
        if emphasis == "normal" and (answer := _ANSWER_RE.match(raw)) is not None:
            piece_emphasis = "answer"
            raw = answer.group("rest").strip()
            if not raw:
                blocks.append(_prose(ctx, "", "answer"))
                return
        blocks.append(_prose(ctx, raw, piece_emphasis))

    while i < n:
        char = text[i]
        if char == "\\" and i + 1 < n and text[i + 1] == "$":
            buffer.append("$")
            i += 2
            continue
        if char != "$":
            buffer.append(char)
            i += 1
            continue

        delim = "$$" if text.startswith("$$", i) else "$"
        close = _find_close(text, i + len(delim), delim)
        if close is None:
            # A lone dollar. Literal, and the rest of the paragraph is still scanned.
            buffer.append(delim)
            i += len(delim)
            continue
        latex = text[i + len(delim) : close].strip()
        # Empty math, or math ending in a dangling backslash, is not math. `$ $` is two
        # literal dollars and `$$x\ $$` is not valid LaTeX; either would also fail to
        # survive re-serialisation, since the closing delimiter would read as escaped.
        if not latex or _trailing_backslashes(latex) % 2 == 1:
            buffer.append(delim)
            i += len(delim)
            continue
        flush()
        blocks.append(_math(ctx, latex, display=delim == "$$"))
        i = close + len(delim)

    flush()
    return blocks


# ------------------------------------------------------------------ unit scan


@dataclass(frozen=True)
class _Unit:
    kind: str  # "fence" | "heading" | "quote" | "para" | "gap"
    lines: tuple[str, ...] = ()
    blanks: int = 0


def _scan_units(lines: list[str]) -> list[_Unit]:
    units: list[_Unit] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        if not line.strip():
            start = i
            while i < n and not lines[i].strip():
                i += 1
            units.append(_Unit("gap", blanks=i - start))
            continue

        fence = _FENCE_RE.match(line)
        if fence is not None:
            marker = fence.group("fence")
            char, width = marker[0], len(marker)
            close_re = re.compile(rf"^ {{0,3}}{re.escape(char)}{{{width},}}[ \t]*$")
            body = [line]
            i += 1
            closed = False
            while i < n:
                body.append(lines[i])
                i += 1
                if close_re.match(body[-1]):
                    closed = True
                    break
            if not closed:
                # Unterminated fence: drop trailing blank lines so that re-parsing our
                # own output (which ends in a newline) yields the same block.
                while body and not body[-1].strip():
                    body.pop()
            units.append(_Unit("fence", tuple(body)))
            continue

        if _HEADING_RE.match(line) is not None:
            units.append(_Unit("heading", (line,)))
            i += 1
            continue

        if _QUOTE_RE.match(line) is not None:
            body = []
            while i < n and (quoted := _QUOTE_RE.match(lines[i])) is not None:
                body.append(quoted.group("text"))
                i += 1
            units.append(_Unit("quote", tuple(body)))
            continue

        body = []
        while i < n:
            candidate = lines[i]
            if not candidate.strip():
                break
            if _FENCE_RE.match(candidate) is not None:
                break
            if _HEADING_RE.match(candidate) is not None:
                break
            if _QUOTE_RE.match(candidate) is not None:
                break
            body.append(candidate)
            i += 1
        units.append(_Unit("para", tuple(body)))

    return units


# ------------------------------------------------------------------ units -> blocks


def _strip_quote_markers(text: str) -> str:
    out = []
    for line in text.split("\n"):
        while (quoted := _QUOTE_RE.match(line)) is not None:
            line = quoted.group("text")
        out.append(line)
    return "\n".join(out)


def _unit_blocks(ctx: _Ctx, unit: _Unit, depth: int) -> list[Block]:
    if unit.kind == "fence":
        # Verbatim, fences and all, and NEVER handed to the inline scanner.
        return [_prose(ctx, "\n".join(unit.lines), "normal")]

    if unit.kind == "heading":
        match = _HEADING_RE.match(unit.lines[0])
        assert match is not None  # the scanner only emits a heading unit if it matched
        text = (match.group("text") or "").strip()
        if not text:
            return [_prose(ctx, "", "heading")]
        return _inline_blocks(ctx, text, "heading")

    if unit.kind == "quote":
        inner = "\n".join(unit.lines)
        if depth >= MAX_QUOTE_DEPTH:
            # Stop recursing, but keep the text: strip EVERY remaining `>` marker and
            # emit prose. Stripping all of them (not one) is what makes the cut-off a
            # fixpoint — re-serialising re-adds exactly MAX_QUOTE_DEPTH markers, so the
            # second parse stops at the same depth with the same text.
            return _inline_blocks(ctx, _strip_quote_markers(inner), "normal")
        children = _parse_blocks(ctx, inner, depth + 1)
        if not children:
            return []
        return [_boxed(ctx, children)]

    text = "\n".join(unit.lines).strip()
    if not text:
        return []
    return _inline_blocks(ctx, text, "normal")


def _parse_blocks(ctx: _Ctx, text: str, depth: int) -> list[Block]:
    blocks: list[Block] = []
    pending_gap = 0

    for unit in _scan_units(text.split("\n")):
        if unit.kind == "gap":
            pending_gap = max(pending_gap, unit.blanks)
            continue
        produced = _unit_blocks(ctx, unit, depth)
        if not produced:
            continue
        # A run of 2+ blank lines is an intentional visual gap -> exactly one spacer.
        # A single blank line is just a paragraph separator. Leading and trailing runs
        # never become spacers: a spacer at the edge would grow on every round trip.
        if blocks and pending_gap >= 2:
            blocks.append(_spacer(ctx))
        pending_gap = 0
        blocks.extend(produced)

    return blocks


def parse_markdown(text: str, *, doc_id: str, source_path: str | None = None) -> Document:
    """Parse markdown into a Document. Never raises on malformed input."""
    ctx = _Ctx()
    blocks = _parse_blocks(ctx, text.replace("\r\n", "\n").replace("\r", "\n"), 0)
    title = next(
        (b.text for b in blocks if isinstance(b, ProseBlock) and b.emphasis == "heading" and b.text),
        "",
    )
    return Document(id=doc_id, title=title, blocks=blocks, source_path=source_path)


# ------------------------------------------------------------------ back to text


def _is_fence_prose(text: str) -> bool:
    return text.startswith(_FENCE_MARKERS)


def _escape_dollars(text: str) -> str:
    return text.replace("$", "\\$")


def _block_to_markdown(block: Block) -> str:
    if isinstance(block, ProseBlock):
        if block.emphasis == "heading":
            return f"# {_escape_dollars(block.text)}".rstrip()
        if block.emphasis == "answer":
            return f"{_ANSWER_PREFIX}{_escape_dollars(block.text)}".rstrip()
        if _is_fence_prose(block.text):
            return block.text
        return _escape_dollars(block.text)

    if isinstance(block, MathBlock):
        delim = "$$" if block.display else "$"
        return f"{delim}{block.latex}{delim}"

    if isinstance(block, SpacerBlock):
        # The "\n\n" join around it supplies the blank-line run.
        return ""

    if isinstance(block, BoxedBlock):
        inner = "\n\n".join(_block_to_markdown(child) for child in block.children)
        # `> ` on content lines, bare `>` on blank ones. Deliberately no rstrip: trailing
        # whitespace inside a paragraph is part of the block text and must survive.
        return "\n".join(f"> {line}" if line else ">" for line in inner.split("\n"))

    if isinstance(block, DiagramBlock):
        raise MarkdownSerialiseError(
            f"Block {block.id!r} is a diagram, which has no markdown form. Diagrams are "
            "generated into the document; export the document as JSON instead of "
            "round-tripping it through markdown."
        )

    raise MarkdownSerialiseError(
        f"Block {block.id!r} has kind {getattr(block, 'kind', type(block).__name__)!r}, "
        "which this serialiser does not know. The block union is frozen in "
        "document/schema.py; this module needs a matching case."
    )


def document_to_markdown(doc: Document) -> str:
    """Render a Document back to markdown.

    Lossy by design — heading level, the original `$$`/`$` line layout, and the exact
    blank-line pattern are not block data. It is STABLE, though:
    `parse(to_markdown(parse(x))) == parse(x)`, ids and seeds included, which is what
    the property test pins.
    """
    return "\n\n".join(_block_to_markdown(block) for block in doc.blocks) + "\n"
