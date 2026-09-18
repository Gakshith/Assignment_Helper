"""TEMPORARY SEAM FILLERS. Delete the day the document strand lands.

`assignment_helper/document/filestore.py` (FileDocumentStore) and markdown ingest are
another strand's work and do not exist on this branch. That seam is deliberate: the
server strand codes against the frozen DocumentStore Protocol and tests against its own
fake.

But a server strand that has never run its own server is not done, and running one
needs *a* store. So these exist, and they are BYPASSES: cli.py prints each of them in
the startup banner (invariant I15 - you can never be unknowingly in one), and the CLI
prefers the real implementations the moment they are importable.

Nothing here tries to be the real thing. The loader does not parse markdown; it splits
on blank lines. It is a placeholder that says so.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from assignment_helper.document.schema import Delta, Document, ProseBlock, Snapshot
from assignment_helper.document.store import DeltaRejected

FALLBACK_STORE_BYPASS = (
    "in-memory document store (assignment_helper.document.filestore has not landed)"
)
FALLBACK_LOADER_BYPASS = (
    "paragraph-splitting document loader (markdown ingest has not landed)"
)


def load_plain(path: Path) -> Document:
    """One prose block per blank-line-separated paragraph. NOT markdown ingest."""
    text = Path(path).read_text(encoding="utf-8")
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    blocks = [
        ProseBlock(id=f"b{i}", seed=1000 + i, text=paragraph)
        for i, paragraph in enumerate(paragraphs)
    ]
    return Document(id=Path(path).stem, title=Path(path).stem, blocks=blocks, source_path=str(path))


class MemoryDocumentStore:
    """Satisfies the frozen DocumentStore Protocol. Never writes to disk.

    Version semantics are the store contract's, not invented here: version starts at 0,
    increments by exactly 1 per accepted change, and a parent_version mismatch raises
    DeltaRejected carrying both versions.
    """

    def __init__(self, doc: Document) -> None:
        self._doc = doc
        self._version = 0
        self._handlers: list[Callable[[Snapshot, str], None]] = []

    @property
    def version(self) -> int:
        return self._version

    def snapshot(self) -> Snapshot:
        return Snapshot(version=self._version, document=self._doc)

    def apply(self, delta: Delta) -> Snapshot:
        if delta.parent_version != self._version:
            raise DeltaRejected(delta.parent_version, self._version)

        blocks = list(self._doc.blocks)
        style = self._doc.style
        # Built to completion first, swapped in second: a delta that fails partway
        # leaves the document exactly as it was (the store contract's atomicity rule).
        for op in delta.ops:
            if op.op == "insert":
                blocks.insert(op.index, op.block)
            elif op.op == "remove":
                before = len(blocks)
                blocks = [b for b in blocks if b.id != op.block_id]
                if len(blocks) == before:
                    raise ValueError(f"remove: no block {op.block_id!r}")
            elif op.op == "replace":
                index = next((i for i, b in enumerate(blocks) if b.id == op.block_id), None)
                if index is None:
                    raise ValueError(f"replace: no block {op.block_id!r}")
                blocks[index] = op.block
            elif op.op == "style":
                style = op.style

        self._doc = self._doc.model_copy(update={"blocks": blocks, "style": style})
        self._version += 1
        return self._notify(delta.origin)

    def replace(self, doc: Document, origin: str) -> Snapshot:
        self._doc = doc
        self._version += 1
        return self._notify(origin)

    def subscribe(self, handler: Callable[[Snapshot, str], None]) -> None:
        self._handlers.append(handler)

    def _notify(self, origin: str) -> Snapshot:
        snap = self.snapshot()
        for handler in self._handlers:
            handler(snap, origin)
        return snap
