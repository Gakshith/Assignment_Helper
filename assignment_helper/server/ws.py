"""The WebSocket delta protocol and the two-tab ownership rules.

THE SERVER DOCUMENT IS AUTHORITATIVE (invariant I4). A client holds (version, doc). A
delta whose parent_version != the server's current version is REJECTED with both
versions attached, and the client fetches a snapshot. Nothing is ever merged blindly.

Acceptance row 15 crossed with invariant I6 is a real defect the red team found, and
this module is where it is fixed. The naive implementation promotes the second tab the
instant the first tab's socket drops. But a socket drop is not a departure — a laptop
lid, a sleeping Wi-Fi radio or a paused debugger all drop the socket while tab 1 is
very much alive, and promoting tab 2 there produces two writable tabs over one
authoritative document.

    PROMOTION REQUIRES THE FULL RECONNECT BUDGET TO EXPIRE: 3 s x 5 attempts = 15 s.
    NOT the first disconnect.

The budget is the SAME constant the client reconnects on (I6: every timeout has a
named, visible fallback), so the two cannot drift apart. While the budget is running
the owner slot is RESERVED, not free: tab 1 reclaims it by reconnecting with the same
client id, and tab 2 stays read-only throughout.

Ownership state lives in OwnershipRegistry, which is pure and clock-injected precisely
so the 4-second blip and the 15-second expiry are both testable without sleeping.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol

# I6, stated once, for both runtimes. web/src/app/protocol.ts carries the same numbers
# and tests/unit/protocol.test.ts asserts them.
RECONNECT_DELAY_S = 3.0
RECONNECT_ATTEMPTS = 5
RECONNECT_BUDGET_S = RECONNECT_DELAY_S * RECONNECT_ATTEMPTS  # 15.0

DISCONNECT_BANNER = "disconnected from the local server"


class Role(StrEnum):
    OWNER = "owner"
    READER = "reader"


@dataclass(frozen=True)
class Admission:
    """What a joining or sweeping client is told about its role, and why."""

    role: Role
    owner_client_id: str | None
    promoted: bool = False
    reclaimed: bool = False
    reason: str = ""


class OwnershipRegistry:
    """Row 15 x I6. Pure, deterministic, clock-injected. No I/O, no asyncio."""

    def __init__(
        self,
        budget_s: float = RECONNECT_BUDGET_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._budget = budget_s
        self._clock = clock
        self._owner: str | None = None
        self._owner_lost_at: float | None = None
        # client_id -> the moment it first joined. Insertion order decides who is next
        # in line, so promotion is first-come rather than arbitrary.
        self._live: dict[str, float] = {}

    # ---------------------------------------------------------------- queries

    @property
    def owner_client_id(self) -> str | None:
        return self._owner

    @property
    def live_client_ids(self) -> tuple[str, ...]:
        return tuple(self._live)

    def role_of(self, client_id: str) -> Role:
        return Role.OWNER if client_id == self._owner else Role.READER

    def grace_remaining_s(self, now: float | None = None) -> float:
        """Seconds left on the owner's reconnect budget. 0.0 when not in grace."""
        if self._owner_lost_at is None:
            return 0.0
        now = self._clock() if now is None else now
        return max(0.0, self._budget - (now - self._owner_lost_at))

    @property
    def owner_in_grace(self) -> bool:
        return self._owner_lost_at is not None

    # ---------------------------------------------------------------- mutations

    def join(self, client_id: str, now: float | None = None) -> Admission:
        now = self._clock() if now is None else now
        self._live.setdefault(client_id, now)

        if self._owner is None:
            self._owner = client_id
            self._owner_lost_at = None
            return Admission(Role.OWNER, self._owner, reason="first tab to connect")

        if self._owner == client_id:
            # The owner is back inside its budget. This is the branch that makes a
            # brief blip a non-event: nothing was promoted while it was away.
            was_in_grace = self._owner_lost_at is not None
            self._owner_lost_at = None
            return Admission(
                Role.OWNER,
                self._owner,
                reclaimed=was_in_grace,
                reason="reconnected within the reconnect budget" if was_in_grace else "owner",
            )

        # Somebody else owns the document. The only way this client takes it is if the
        # owner is gone AND its full budget has already run out.
        if self._owner not in self._live and self._owner_lost_at is not None:
            if now - self._owner_lost_at >= self._budget:
                previous = self._owner
                self._owner = client_id
                self._owner_lost_at = None
                return Admission(
                    Role.OWNER,
                    client_id,
                    promoted=True,
                    reason=(
                        f"the owning tab ({previous}) did not return within "
                        f"{self._budget:g}s ({RECONNECT_DELAY_S:g}s x {RECONNECT_ATTEMPTS})"
                    ),
                )

        return Admission(
            Role.READER,
            self._owner,
            reason=f"another tab ({self._owner}) is editing this document",
        )

    def drop(self, client_id: str, now: float | None = None) -> None:
        """A socket closed. If it was the owner's, the slot is RESERVED, not freed."""
        now = self._clock() if now is None else now
        self._live.pop(client_id, None)
        if client_id == self._owner:
            self._owner_lost_at = now

    def sweep(self, now: float | None = None) -> Admission | None:
        """Expire a lapsed owner. Returns the promotion, if one happened.

        Called on a timer, because tab 2 is sitting there connected and must be
        promoted when the budget runs out even though no new event arrives.
        """
        if self._owner is None or self._owner_lost_at is None:
            return None
        now = self._clock() if now is None else now
        if now - self._owner_lost_at < self._budget:
            return None  # still in grace. Tab 1 may yet come back.

        previous = self._owner
        self._owner_lost_at = None
        heir = next(iter(self._live), None)
        if heir is None:
            self._owner = None
            return None
        self._owner = heir
        return Admission(
            Role.OWNER,
            heir,
            promoted=True,
            reason=(
                f"the owning tab ({previous}) did not return within "
                f"{self._budget:g}s ({RECONNECT_DELAY_S:g}s x {RECONNECT_ATTEMPTS})"
            ),
        )


# ---------------------------------------------------------------- the hub


class SocketLike(Protocol):
    async def send_json(self, data: Any) -> None: ...


@dataclass
class Connection:
    client_id: str
    socket: SocketLike
    role: Role = Role.READER
    joined_at: float = field(default_factory=time.monotonic)


class ConnectionHub:
    """Connection registry plus fan-out. One open document per server process (v1)."""

    def __init__(
        self,
        registry: OwnershipRegistry | None = None,
        *,
        sweep_interval_s: float = 0.5,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.registry = registry or OwnershipRegistry(clock=clock)
        self._conns: dict[str, Connection] = {}
        self._sweep_interval = sweep_interval_s
        self._sweeper: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------ lifecycle

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Remember the serving loop so background THREADS (the file watcher, and any
        store callback) can hand work back without guessing at a loop."""
        self._loop = loop

    async def start(self) -> None:
        self.bind_loop(asyncio.get_running_loop())
        if self._sweeper is None:
            self._sweeper = asyncio.create_task(self._sweep_forever())

    async def stop(self) -> None:
        task, self._sweeper = self._sweeper, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _sweep_forever(self) -> None:
        while True:
            await asyncio.sleep(self._sweep_interval)
            await self.sweep_once()

    async def sweep_once(self) -> Admission | None:
        promotion = self.registry.sweep()
        if promotion is None:
            return None
        await self._announce_roles(
            reason=promotion.reason, promoted_client_id=promotion.owner_client_id
        )
        return promotion

    # ------------------------------------------------------------ membership

    async def register(self, client_id: str, socket: SocketLike) -> Admission:
        admission = self.registry.join(client_id)
        self._conns[client_id] = Connection(client_id, socket, admission.role)
        # Everybody's banner is derived from who owns the document, so a join that
        # changes ownership has to reach the other tabs too.
        if admission.promoted or admission.reclaimed:
            await self._announce_roles(reason=admission.reason, promoted_client_id=client_id)
        else:
            self._sync_roles()
        return admission

    async def unregister(self, client_id: str) -> None:
        self._conns.pop(client_id, None)
        self.registry.drop(client_id)
        # DELIBERATELY no promotion here. Row 15 x I6: a drop starts the budget, it
        # does not end it. sweep_once() promotes, and only after the budget expires.
        self._sync_roles()

    def _sync_roles(self) -> None:
        for conn in self._conns.values():
            conn.role = self.registry.role_of(conn.client_id)

    def role_of(self, client_id: str) -> Role:
        return self.registry.role_of(client_id)

    @property
    def client_ids(self) -> tuple[str, ...]:
        return tuple(self._conns)

    # ------------------------------------------------------------ messaging

    def banner_for(self, client_id: str) -> dict[str, Any] | None:
        """Row 15: the read-only tab shows a banner NAMING the owner tab."""
        if self.registry.role_of(client_id) is Role.OWNER:
            return None
        owner = self.registry.owner_client_id
        return {
            "code": "document.read-only",
            "message": (
                f"This tab is read-only: tab {owner} is editing this document. "
                "It follows along live."
            ),
            "owner_client_id": owner,
        }

    def hello(self, client_id: str, version: int, admission: Admission) -> dict[str, Any]:
        return {
            "type": "hello",
            "client_id": client_id,
            "role": admission.role.value,
            "owner_client_id": admission.owner_client_id,
            "version": version,
            "reason": admission.reason,
            "banner": self.banner_for(client_id),
            "reconnect": {
                "delay_s": RECONNECT_DELAY_S,
                "attempts": RECONNECT_ATTEMPTS,
                "budget_s": RECONNECT_BUDGET_S,
                "on_exhausted": DISCONNECT_BANNER,
            },
        }

    async def _announce_roles(self, *, reason: str, promoted_client_id: str | None) -> None:
        self._sync_roles()
        for client_id, conn in list(self._conns.items()):
            await self._send(
                conn,
                {
                    "type": "role",
                    "role": conn.role.value,
                    "owner_client_id": self.registry.owner_client_id,
                    "promoted": client_id == promoted_client_id,
                    "reason": reason,
                    "banner": self.banner_for(client_id),
                },
            )

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Fan out to EVERY connection, the originator included.

        The originator is not excluded on purpose. kernel.ts reacts to a remote delta by
        re-reading the server's snapshot, so echoing the delta back is what makes the
        sender adopt the authoritative version instead of trusting its own optimism (I4).
        """
        for conn in list(self._conns.values()):
            await self._send(conn, message)

    async def send_to(self, client_id: str, message: dict[str, Any]) -> None:
        conn = self._conns.get(client_id)
        if conn is None:
            return
        await self._send(conn, message)

    async def _send(self, conn: Connection, message: dict[str, Any]) -> None:
        try:
            await conn.socket.send_json(message)
        except Exception as exc:
            # I5: not swallowed. A socket that cannot be written to is a socket that has
            # gone away, and the registry has to hear about it or the owner slot leaks.
            print(
                f"[ws] dropping connection {conn.client_id}: send failed "
                f"({type(exc).__name__}: {exc})",
                flush=True,
            )
            self._conns.pop(conn.client_id, None)
            self.registry.drop(conn.client_id)

    # ------------------------------------------------------------ thread bridge

    def dispatch_threadsafe(self, message: dict[str, Any]) -> None:
        """Broadcast from a non-async thread (the file watcher, a store callback).

        Raises if no loop is bound. A fan-out that quietly goes nowhere would make the
        watcher look like it was working when it was not (I5).
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            raise RuntimeError(
                "ConnectionHub has no running event loop bound; call bind_loop()/start() "
                "before dispatching from a background thread."
            )
        loop.call_soon_threadsafe(lambda: loop.create_task(self.broadcast(message)))
