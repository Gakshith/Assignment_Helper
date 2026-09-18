"""Acceptance row 22: probe 7420-7429, then refuse with a message."""

from __future__ import annotations

import socket

import pytest

from assignment_helper.app import PORT_RANGE, choose_port


def test_the_range_is_7420_to_7429():
    assert PORT_RANGE.start == 7420
    assert PORT_RANGE.stop - 1 == 7429


def test_two_instances_get_two_different_ports():
    first = choose_port()
    # Hold the first port the way a running server would, then probe again.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as held:
        held.bind(("127.0.0.1", first))
        held.listen(1)
        second = choose_port()
    assert second != first
    assert first in PORT_RANGE and second in PORT_RANGE


def _free_ports(count: int) -> list[int]:
    """Ports the OS has just told us are free, held open until we say otherwise."""
    socks = [socket.socket(socket.AF_INET, socket.SOCK_STREAM) for _ in range(count)]
    try:
        for s in socks:
            s.bind(("127.0.0.1", 0))
        ports = [s.getsockname()[1] for s in socks]
    finally:
        for s in socks:
            s.close()
    return ports


def test_exhausting_the_range_refuses_with_a_message(monkeypatch):
    """Row 22: refuse WITH A MESSAGE. Not a bare exception, not the next port up.

    The range is monkeypatched to ports the OS just confirmed free, rather than using
    the real 7420-7429. The earlier version of this test bound the whole production
    range and asserted it got all ten, which fails on any machine where an instance of
    assignment-helper is actually running — including the developer's. A test that goes
    red because the product is running is a test that gets ignored.
    """
    import assignment_helper.app as app_module

    ports = _free_ports(2)
    monkeypatch.setattr(app_module, "PORT_RANGE", range(ports[0], ports[0] + 2))

    held: list[socket.socket] = []
    try:
        for _ in range(2):
            port = app_module.choose_port()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", port))
            sock.listen(1)
            held.append(sock)

        with pytest.raises(RuntimeError) as excinfo:
            app_module.choose_port()
        message = str(excinfo.value)
        assert str(ports[0]) in message
        assert "in use" in message
        assert "--port" in message
    finally:
        for sock in held:
            sock.close()


def test_the_real_range_is_the_documented_one():
    # Kept separate: the constant is part of the product's documented behaviour even
    # though the probing test above no longer depends on the range being free.
    assert list(PORT_RANGE) == list(range(7420, 7430))


def test_a_chosen_port_is_actually_bindable():
    port = choose_port()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", port))  # would raise if the probe lied
