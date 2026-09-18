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


def test_ten_instances_exhaust_the_range_and_the_eleventh_refuses_with_a_message():
    held: list[socket.socket] = []
    taken: list[int] = []
    try:
        for _ in range(len(PORT_RANGE)):
            port = choose_port()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.bind(("127.0.0.1", port))
            sock.listen(1)
            held.append(sock)
            taken.append(port)

        assert sorted(taken) == sorted(PORT_RANGE)

        with pytest.raises(RuntimeError) as excinfo:
            choose_port()
        message = str(excinfo.value)
        # Row 22: refuse WITH A MESSAGE. Not a bare exception, not port 7430.
        assert "7420-7429" in message
        assert "in use" in message
        assert "--port" in message
    finally:
        for sock in held:
            sock.close()


def test_a_chosen_port_is_actually_bindable():
    port = choose_port()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", port))  # would raise if the probe lied
