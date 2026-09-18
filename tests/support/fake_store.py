"""An in-memory DocumentStore for the server strand's tests.

THE SEAM IS DELIBERATE. `assignment_helper/document/filestore.py` (FileDocumentStore)
is the document strand's file and does not exist on this branch. The server strand
codes against the frozen Protocol in assignment_helper/document/store.py and tests
against this fake, so neither strand waits for the other and neither guesses at the
other's internals.

This fake implements the store contract's version semantics exactly:
  * version starts at 0 and increments by exactly 1 per accepted change
  * a delta whose parent_version != the current version raises DeltaRejected carrying
    BOTH versions
  * apply() is atomic - a delta that fails partway leaves the document unchanged
"""

from __future__ import annotations

from collections.abc import Callable

from assignment_helper.document.schema import Delta, Document, ProseBlock, Snapshot
from assignment_helper.document.store import DeltaRejected


class FakeDocumentStore:
    def __init__(self, doc: Document | None = None) -> None:
        self._doc = doc or Document(id="fake", title="fake")
        self._version = 0
        self._handlers: list[Callable[[Snapshot, str], None]] = []
        self.applied: list[Delta] = []

    @property
    def version(self) -> int:
        return self._version

    @property
    def document(self) -> Document:
        return self._doc

    def snapshot(self) -> Snapshot:
        return Snapshot(version=self._version, document=self._doc)

    def apply(self, delta: Delta) -> Snapshot:
        if delta.parent_version != self._version:
            raise DeltaRejected(delta.parent_version, self._version)

        blocks = list(self._doc.blocks)
        style = self._doc.style
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
        self.applied.append(delta)
        return self._emit(delta.origin)

    def replace(self, doc: Document, origin: str) -> Snapshot:
        self._doc = doc
        self._version += 1
        return self._emit(origin)

    def subscribe(self, handler: Callable[[Snapshot, str], None]) -> None:
        self._handlers.append(handler)

    def _emit(self, origin: str) -> Snapshot:
        snap = self.snapshot()
        for handler in self._handlers:
            handler(snap, origin)
        return snap


def prose(block_id: str, text: str, seed: int = 7) -> ProseBlock:
    return ProseBlock(id=block_id, seed=seed, text=text)


def doc_with(*texts: str) -> Document:
    return Document(
        id="fixture",
        title="fixture",
        blocks=[prose(f"b{i}", t, seed=100 + i) for i, t in enumerate(texts)],
    )


class RecordingSocket:
    """A SocketLike that just remembers what it was sent."""

    def __init__(self, client_id: str = "tab") -> None:
        self.client_id = client_id
        self.sent: list[dict] = []
        self.closed = False

    async def send_json(self, data: dict) -> None:
        if self.closed:
            raise RuntimeError("socket closed")
        self.sent.append(data)

    def of_type(self, kind: str) -> list[dict]:
        return [m for m in self.sent if m.get("type") == kind]
