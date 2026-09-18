"""--selftest must FAIL LOUDLY, naming what it expected. Never a quiet pass."""

from __future__ import annotations

import argparse

import pytest

from assignment_helper.app import ServerConfig
from assignment_helper.cli import (
    active_bypasses,
    banner,
    build_parser,
    check_pins,
    print_selftest,
    read_pins,
    run_selftest,
)
from assignment_helper.version import VersionInfo

PINS = {"fastapi": "0.141.1", "uvicorn": "0.53.0"}


def test_exact_pins_pass():
    assert check_pins(PINS, lambda name: PINS[name]) == []


def test_a_wrong_pinned_version_fails_and_names_both_versions():
    def lookup(name: str) -> str:
        return "0.140.0" if name == "fastapi" else PINS[name]

    failures = check_pins(PINS, lookup)
    assert len(failures) == 1
    assert "fastapi" in failures[0]
    assert "0.141.1" in failures[0], "the EXPECTED version must be named"
    assert "0.140.0" in failures[0], "the FOUND version must be named"


def test_a_missing_dependency_fails_and_says_not_installed():
    failures = check_pins(PINS, lambda name: None if name == "uvicorn" else PINS[name])
    assert len(failures) == 1
    assert "NOT INSTALLED" in failures[0]
    assert "0.53.0" in failures[0]


def test_pins_are_read_from_pyproject_and_are_all_exact():
    pins = read_pins()
    assert "fastapi" in pins and "uvicorn" in pins and "pydantic" in pins
    # I17: the CV stack is an optional extra and must NOT be asserted by --selftest,
    # because asserting it would mean importing it.
    for forbidden in ("opencv-python", "scikit-image", "numpy"):
        assert forbidden not in pins
    # watchfiles was dropped deliberately; it must not creep back in.
    assert "watchfiles" not in pins


def test_selftest_fails_loudly_on_a_deliberately_wrong_pin(tmp_path, capsys):
    result = run_selftest(lookup=lambda name: "6.6.6")
    assert not result.ok
    assert any("expected ==" in f and "found ==6.6.6" in f for f in result.failures)

    code = print_selftest(result, VersionInfo("0.1.0.dev+abc", True), colour=False)
    assert code == 1
    out = capsys.readouterr().out
    assert "FAIL" in out
    assert "selftest FAILED" in out


def test_selftest_fails_on_a_non_arm64_interpreter():
    result = run_selftest(machine="x86_64")
    assert not result.ok
    assert any("expected arm64" in f and "x86_64" in f for f in result.failures)


def test_selftest_fails_when_the_web_bundle_is_missing(tmp_path):
    result = run_selftest(static_dir=tmp_path / "nope")
    assert any("web bundle" in f and "npm run build" in f for f in result.failures)


def test_selftest_passes_when_everything_lines_up(tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html>")
    result = run_selftest(
        machine="arm64",
        static_dir=tmp_path,
        lookup=lambda name: read_pins()[name],
    )
    assert result.ok, result.failures


# ---------------------------------------------------------------- I15


def _args(**kwargs) -> argparse.Namespace:
    parsed = build_parser().parse_args(["doc.md"])
    for key, value in kwargs.items():
        setattr(parsed, key, value)
    return parsed


@pytest.mark.parametrize(
    "kwargs, needle",
    [
        ({"no_artifacts": True}, "--no-artifacts"),
        ({"dpi": 300}, "--dpi"),
        ({"seed": 42}, "--seed"),
        ({"no_keyring": True}, "--no-keyring"),
        ({"offline": True}, "--offline"),
        ({"browser": "safari"}, "--browser"),
    ],
)
def test_i15_every_bypass_flag_appears_in_the_banner(kwargs, needle):
    args = _args(**kwargs)
    lines = active_bypasses(args)
    assert any(needle in line for line in lines), f"{needle} was not announced: {lines}"

    text = banner(
        VersionInfo("1.0.0", False),
        ServerConfig(port=7420),
        None,
        lines,
        colour=False,
    )
    assert needle in text


def test_i15_all_six_bypasses_at_once_are_all_announced():
    args = _args(
        no_artifacts=True, dpi=300, seed=42, no_keyring=True, offline=True, browser="safari"
    )
    lines = active_bypasses(args)
    assert len(lines) == 6


def test_a_clean_launch_says_bypasses_none():
    text = banner(VersionInfo("1.0.0", False), ServerConfig(port=7420), None, [], colour=False)
    assert "bypasses   none" in text


def test_a_dev_build_prints_the_development_banner():
    text = banner(
        VersionInfo("1.0.0.dev+f1322a7.dirty", True, sha="f1322a7", dirty=True, note="4 commits"),
        ServerConfig(port=7420),
        None,
        [],
        colour=False,
    )
    assert "DEVELOPMENT BUILD" in text
    assert "uncommitted changes" in text


def test_a_release_build_prints_no_development_banner():
    text = banner(VersionInfo("1.0.0", False), ServerConfig(port=7420), None, [], colour=False)
    assert "DEVELOPMENT" not in text


def test_a_dev_build_banner_is_red_on_a_tty():
    text = banner(
        VersionInfo("1.0.0.dev+abc", True, note="n"), ServerConfig(port=7420), None, [], colour=True
    )
    assert "\033[31m" in text


# ---------------------------------------------------------------- I16


def test_the_banner_never_contains_the_session_token():
    from assignment_helper.security import SessionToken

    token = SessionToken()
    text = banner(
        VersionInfo("1.0.0", False),
        ServerConfig(port=7420),
        None,
        active_bypasses(_args(offline=True)),
        colour=False,
    )
    assert token.value not in text
    assert "?t=" not in text
    assert "never printed" in text
