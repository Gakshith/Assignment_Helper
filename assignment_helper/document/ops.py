"""Pure delta application. `apply_ops(doc, ops) -> Document`.

This module is the only place that knows how an `Op` changes a `Document`. It is a
pure function: it never touches the filesystem, never mutates its argument, and never
looks at the clock. `assignment_helper.document.filestore` wraps it with persistence.

ATOMICITY. A sequence of ops either applies completely or not at all. The new block
list is built to one side and the new `Document` is constructed only after the last op
has succeeded, so a failure partway through leaves the caller's document byte-identical
to what it was. Blocks are `frozen=True`, so nothing can be edited in place by accident.

NO SILENT NO-OPS (invariant I5). Removing or replacing a block id that is not in the
document raises `OpFailed`. It is tempting to treat it as a no-op — the document already
looks the way the op wanted it to. That is exactly the bug: the server would accept the
delta, bump the version, and hand back a snapshot that the client believes contains its
edit. Two clients drift apart and nothing anywhere reports a fault.

Ops address blocks by id and the search RECURSES into `BoxedBlock.children`, so a math
line inside a boxed answer can be replaced without rewriting the box. Insertion is
top-level only: `InsertBlock.index` is an index into `Document.blocks`. To add a child to
a box, replace the box.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence

from assignment_helper.document.schema import (
    Block,
    BoxedBlock,
    Document,
    InsertBlock,
    Problem,
    RemoveBlock,
    ReplaceBlock,
    SetStyle,
    Style,
)

__all__ = ["OpFailed", "apply_ops", "iter_block_ids"]

# How many ids to name in an error message before truncating. A 400-block document
# should still produce an error a human can read.
_MAX_IDS_IN_MESSAGE = 12


class OpFailed(Exception):
    """A delta could not be applied. Carries a code so the router can map it to a
    typed `Problem` instead of a bare 500 (invariant I5)."""

    def __init__(self, code: str, message: str, *, block_id: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.block_id = block_id

    def as_problem(self) -> Problem:
        return Problem(
            scope="block" if self.block_id else "page",
            code=self.code,
            message=self.message,
            block_id=self.block_id,
        )


def iter_block_ids(blocks: Sequence[Block]) -> Iterator[str]:
    """Every block id in the tree, including ids nested inside boxed answers."""
    for block in blocks:
        yield block.id
        if isinstance(block, BoxedBlock):
            yield from iter_block_ids(block.children)


def _known_ids(blocks: Sequence[Block]) -> list[str]:
    return list(iter_block_ids(blocks))


def _describe_ids(blocks: Sequence[Block]) -> str:
    ids = _known_ids(blocks)
    if not ids:
        return "the document has no blocks"
    shown = ids[:_MAX_IDS_IN_MESSAGE]
    tail = "" if len(ids) == len(shown) else f", ... ({len(ids)} in total)"
    return "known ids: " + ", ".join(repr(i) for i in shown) + tail


def _remove_block(blocks: Sequence[Block], block_id: str) -> list[Block] | None:
    """Return a new list with `block_id` gone, or None if it was not found."""
    out: list[Block] = []
    found = False
    for block in blocks:
        if block.id == block_id:
            found = True
            continue
        if isinstance(block, BoxedBlock) and not found:
            inner = _remove_block(block.children, block_id)
            if inner is not None:
                found = True
                out.append(block.model_copy(update={"children": inner}))
                continue
        out.append(block)
    return out if found else None


def _replace_block(blocks: Sequence[Block], block_id: str, new: Block) -> list[Block] | None:
    """Return a new list with `block_id` swapped for `new`, or None if not found."""
    out: list[Block] = []
    found = False
    for block in blocks:
        if block.id == block_id and not found:
            found = True
            out.append(new)
            continue
        if isinstance(block, BoxedBlock) and not found:
            inner = _replace_block(block.children, block_id, new)
            if inner is not None:
                found = True
                out.append(block.model_copy(update={"children": inner}))
                continue
        out.append(block)
    return out if found else None


def _reject_duplicate(blocks: Sequence[Block], new_id: str, *, ignoring: str | None = None) -> None:
    for existing in iter_block_ids(blocks):
        if existing == new_id and existing != ignoring:
            raise OpFailed(
                "document.duplicate-block-id",
                f"A block with id {new_id!r} is already in this document. Block ids are "
                "unique across the whole tree, because remove and replace address blocks "
                "by id and a duplicate would make them ambiguous.",
                block_id=new_id,
            )


def apply_ops(doc: Document, ops: Sequence[object]) -> Document:
    """Apply `ops` to `doc` and return the resulting document.

    `doc` is never modified. Raises `OpFailed` if any op cannot be applied; in that case
    nothing from the sequence has taken effect.
    """
    blocks: list[Block] = list(doc.blocks)
    style: Style = doc.style

    for position, op in enumerate(ops):
        match op:
            case InsertBlock():
                if op.index < 0 or op.index > len(blocks):
                    raise OpFailed(
                        "document.index-out-of-range",
                        f"Op {position} wants to insert at index {op.index}, but this "
                        f"document has {len(blocks)} top-level blocks, so the valid range "
                        f"is 0..{len(blocks)}.",
                        block_id=op.block.id,
                    )
                _reject_duplicate(blocks, op.block.id)
                blocks.insert(op.index, op.block)

            case RemoveBlock():
                updated = _remove_block(blocks, op.block_id)
                if updated is None:
                    raise OpFailed(
                        "document.unknown-block-id",
                        f"Op {position} wants to remove block {op.block_id!r}, which is not "
                        f"in this document ({_describe_ids(blocks)}). The delta was rejected "
                        "rather than ignored: a silently dropped op is how two clients end "
                        "up with different documents. Ask for a fresh snapshot and retry.",
                        block_id=op.block_id,
                    )
                blocks = updated

            case ReplaceBlock():
                _reject_duplicate(blocks, op.block.id, ignoring=op.block_id)
                updated = _replace_block(blocks, op.block_id, op.block)
                if updated is None:
                    raise OpFailed(
                        "document.unknown-block-id",
                        f"Op {position} wants to replace block {op.block_id!r}, which is not "
                        f"in this document ({_describe_ids(blocks)}). The delta was rejected "
                        "rather than ignored. Ask for a fresh snapshot and retry.",
                        block_id=op.block_id,
                    )
                blocks = updated

            case SetStyle():
                style = op.style

            case _:
                raise OpFailed(
                    "document.unknown-op",
                    f"Op {position} has type {type(op).__name__!r}, which this build does not "
                    "know how to apply. The op union is frozen in document/schema.py.",
                )

    return doc.model_copy(update={"blocks": blocks, "style": style})
