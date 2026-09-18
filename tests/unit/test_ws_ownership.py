"""Acceptance row 15 crossed with invariant I6 - the defect the red team found.

The naive implementation promotes tab 2 the instant tab 1's socket drops. A lid close,
a sleeping radio or a paused debugger all drop the socket while tab 1 is alive, and
promoting there yields two writable tabs over one authoritative document.

PROMOTION REQUIRES THE FULL RECONNECT BUDGET TO EXPIRE: 3 s x 5 = 15 s.
"""

from __future__ import annotations

import pytest

from assignment_helper.server.ws import (
    RECONNECT_ATTEMPTS,
    RECONNECT_BUDGET_S,
    RECONNECT_DELAY_S,
    Admission,
    ConnectionHub,
    OwnershipRegistry,
    Role,
)

from support.fake_store import RecordingSocket


class Clock:
    def __init__(self, t: float = 0.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> float:
        self.t += seconds
        return self.t


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def registry(clock: Clock) -> OwnershipRegistry:
    return OwnershipRegistry(clock=clock)


def test_the_budget_is_three_seconds_times_five_attempts():
    assert RECONNECT_DELAY_S == 3.0
    assert RECONNECT_ATTEMPTS == 5
    assert RECONNECT_BUDGET_S == 15.0


def test_the_first_tab_owns_and_the_second_is_read_only(registry):
    first = registry.join("tab1")
    second = registry.join("tab2")
    assert first.role is Role.OWNER
    assert second.role is Role.READER
    # Row 15: the banner NAMES the owner tab.
    assert "tab1" in second.reason


# ---------------------------------------------------------------- the defect


def test_a_four_second_blip_does_NOT_promote_tab_two(registry, clock):
    registry.join("tab1")
    registry.join("tab2")

    registry.drop("tab1", now=clock.advance(0))
    clock.advance(4.0)

    assert registry.sweep() is None, "a 4 s blip must not promote anybody"
    assert registry.owner_client_id == "tab1", "the owner slot stays RESERVED during grace"
    assert registry.role_of("tab2") is Role.READER
    assert registry.owner_in_grace is True
    assert registry.grace_remaining_s() == pytest.approx(11.0)


def test_tab_one_reclaims_ownership_when_it_comes_back_inside_the_budget(registry, clock):
    registry.join("tab1")
    registry.join("tab2")
    registry.drop("tab1", now=clock.advance(0))
    clock.advance(4.0)
    registry.sweep()

    back = registry.join("tab1")
    assert back.role is Role.OWNER
    assert back.reclaimed is True
    assert registry.role_of("tab2") is Role.READER
    assert registry.owner_in_grace is False


@pytest.mark.parametrize("blip", [0.0, 1.0, 4.0, 9.9, 14.9])
def test_no_promotion_anywhere_inside_the_budget(registry, clock, blip):
    registry.join("tab1")
    registry.join("tab2")
    registry.drop("tab1", now=clock.advance(0))
    clock.advance(blip)
    assert registry.sweep() is None
    assert registry.role_of("tab2") is Role.READER


def test_the_full_budget_expiring_DOES_promote_tab_two(registry, clock):
    registry.join("tab1")
    registry.join("tab2")
    registry.drop("tab1", now=clock.advance(0))

    clock.advance(RECONNECT_BUDGET_S)
    promotion = registry.sweep()

    assert isinstance(promotion, Admission)
    assert promotion.promoted is True
    assert promotion.owner_client_id == "tab2"
    assert registry.role_of("tab2") is Role.OWNER
    assert "15s" in promotion.reason and "3s x 5" in promotion.reason


def test_the_boundary_is_exactly_the_budget(registry, clock):
    registry.join("tab1")
    registry.join("tab2")
    registry.drop("tab1", now=clock.advance(0))

    clock.advance(RECONNECT_BUDGET_S - 0.001)
    assert registry.sweep() is None
    clock.advance(0.001)
    assert registry.sweep() is not None


def test_a_join_after_the_budget_expires_also_takes_ownership(registry, clock):
    registry.join("tab1")
    registry.drop("tab1", now=clock.advance(0))
    clock.advance(RECONNECT_BUDGET_S + 1)

    late = registry.join("tab3")
    assert late.role is Role.OWNER
    assert late.promoted is True


def test_a_join_during_grace_does_NOT_take_ownership(registry, clock):
    registry.join("tab1")
    registry.drop("tab1", now=clock.advance(0))
    clock.advance(2.0)

    late = registry.join("tab3")
    assert late.role is Role.READER
    assert late.owner_client_id == "tab1"


def test_promotion_goes_to_the_earliest_joined_reader(registry, clock):
    registry.join("tab1")
    registry.join("tab2")
    clock.advance(1)
    registry.join("tab3")
    registry.drop("tab1", now=clock.advance(0))
    clock.advance(RECONNECT_BUDGET_S)

    promotion = registry.sweep()
    assert promotion is not None
    assert promotion.owner_client_id == "tab2"


def test_the_last_tab_leaving_frees_the_document(registry, clock):
    registry.join("tab1")
    registry.drop("tab1", now=clock.advance(0))
    clock.advance(RECONNECT_BUDGET_S)
    assert registry.sweep() is None
    assert registry.owner_client_id is None
    assert registry.join("tab9").role is Role.OWNER


def test_a_reader_dropping_changes_nothing(registry, clock):
    registry.join("tab1")
    registry.join("tab2")
    registry.drop("tab2", now=clock.advance(0))
    clock.advance(RECONNECT_BUDGET_S * 2)
    assert registry.sweep() is None
    assert registry.owner_client_id == "tab1"
    assert registry.owner_in_grace is False


# ---------------------------------------------------------------- the hub


async def test_the_hub_gives_the_reader_a_banner_naming_the_owner(clock):
    hub = ConnectionHub(OwnershipRegistry(clock=clock), clock=clock)
    one, two = RecordingSocket("tab1"), RecordingSocket("tab2")
    await hub.register("tab1", one)
    await hub.register("tab2", two)

    assert hub.banner_for("tab1") is None
    banner = hub.banner_for("tab2")
    assert banner is not None
    assert banner["code"] == "document.read-only"
    assert "tab1" in banner["message"]
    assert banner["owner_client_id"] == "tab1"


async def test_the_hello_frame_carries_the_reconnect_budget(clock):
    hub = ConnectionHub(OwnershipRegistry(clock=clock), clock=clock)
    admission = await hub.register("tab1", RecordingSocket("tab1"))
    hello = hub.hello("tab1", 7, admission)
    assert hello["reconnect"] == {
        "delay_s": 3.0,
        "attempts": 5,
        "budget_s": 15.0,
        "on_exhausted": "disconnected from the local server",
    }
    assert hello["version"] == 7


async def test_the_hub_does_not_promote_on_unregister(clock):
    """I6 at the hub level: unregister starts the budget, it does not end it."""
    hub = ConnectionHub(OwnershipRegistry(clock=clock), clock=clock)
    two = RecordingSocket("tab2")
    await hub.register("tab1", RecordingSocket("tab1"))
    await hub.register("tab2", two)

    await hub.unregister("tab1")
    clock.advance(4.0)
    assert await hub.sweep_once() is None
    assert hub.role_of("tab2") is Role.READER
    assert two.of_type("role") == [], "tab 2 must not be told it was promoted"


async def test_the_hub_promotes_and_tells_the_tab_after_the_budget(clock):
    hub = ConnectionHub(OwnershipRegistry(clock=clock), clock=clock)
    two = RecordingSocket("tab2")
    await hub.register("tab1", RecordingSocket("tab1"))
    await hub.register("tab2", two)

    await hub.unregister("tab1")
    clock.advance(RECONNECT_BUDGET_S)
    promotion = await hub.sweep_once()

    assert promotion is not None
    roles = two.of_type("role")
    assert len(roles) == 1
    assert roles[0]["role"] == "owner"
    assert roles[0]["promoted"] is True
    assert roles[0]["banner"] is None


async def test_a_broadcast_reaches_the_sender_too(clock):
    """kernel.ts reacts to a remote delta by re-reading the server snapshot, so the
    originator must receive its own echo or it never adopts the authoritative version."""
    hub = ConnectionHub(OwnershipRegistry(clock=clock), clock=clock)
    one, two = RecordingSocket("tab1"), RecordingSocket("tab2")
    await hub.register("tab1", one)
    await hub.register("tab2", two)

    await hub.broadcast({"type": "delta", "version": 1})
    assert len(one.of_type("delta")) == 1
    assert len(two.of_type("delta")) == 1


async def test_a_dead_socket_is_dropped_rather_than_leaking_the_owner_slot(clock):
    hub = ConnectionHub(OwnershipRegistry(clock=clock), clock=clock)
    one = RecordingSocket("tab1")
    await hub.register("tab1", one)
    one.closed = True

    await hub.broadcast({"type": "delta", "version": 1})
    assert "tab1" not in hub.client_ids


def test_dispatch_threadsafe_without_a_loop_raises_rather_than_vanishing():
    hub = ConnectionHub()
    with pytest.raises(RuntimeError, match="no running event loop"):
        hub.dispatch_threadsafe({"type": "file.conflict"})
