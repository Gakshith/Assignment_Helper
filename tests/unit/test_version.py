"""The dev-build determination. A build that is not on a clean tag must SAY SO."""

from __future__ import annotations

import subprocess
from types import SimpleNamespace

from assignment_helper.version import derive_version, git_describe, parse_describe


def test_a_clean_tag_is_a_release_build():
    info = parse_describe("v1.0.0", "0.1.0")
    assert info.version == "1.0.0"
    assert info.dev_build is False
    assert info.dirty is False


def test_commits_past_a_tag_are_a_dev_build():
    info = parse_describe("v1.0.0-4-gf1322a7", "0.1.0")
    assert info.version == "1.0.0.dev+f1322a7"
    assert info.dev_build is True
    assert info.sha == "f1322a7"
    assert info.dirty is False


def test_a_dirty_tree_is_marked_dirty():
    info = parse_describe("v1.0.0-4-gf1322a7-dirty", "0.1.0")
    assert info.version == "1.0.0.dev+f1322a7.dirty"
    assert info.dev_build is True
    assert info.dirty is True


def test_a_clean_tag_on_a_dirty_tree_is_still_a_dev_build():
    info = parse_describe("v1.0.0-dirty", "0.1.0")
    assert info.dev_build is True
    assert info.dirty is True
    assert "1.0.0" in info.version


def test_no_tag_anywhere_falls_back_to_the_metadata_base():
    info = parse_describe("f1322a7", "0.1.0")
    assert info.version == "0.1.0.dev+f1322a7"
    assert info.dev_build is True


def test_output_we_do_not_model_never_claims_a_release_build():
    info = parse_describe("something-unexpected", "0.1.0")
    assert info.dev_build is True
    assert "unparsed" in info.note


def test_an_installed_wheel_has_no_git_and_is_a_release_build(tmp_path):
    # tmp_path has no .git, which is exactly the shape of an unpacked wheel.
    info = derive_version(tmp_path)
    assert info.dev_build is False
    assert info.note == "installed distribution metadata"


def test_git_present_but_broken_is_a_dev_build_not_a_release(tmp_path):
    (tmp_path / ".git").mkdir()

    def runner(*_args, **_kwargs):
        return SimpleNamespace(returncode=128, stdout="", stderr="fatal: not a repository")

    info = derive_version(tmp_path, runner=runner)
    assert info.dev_build is True
    assert "git describe` failed" in info.note


def test_git_missing_entirely_is_reported_as_no_answer(tmp_path):
    def runner(*_args, **_kwargs):
        raise FileNotFoundError("git")

    assert git_describe(tmp_path, runner=runner) is None


def test_this_worktree_reports_a_dev_build():
    # The real thing: nobody tagged a release, so every strand build is a dev build.
    info = derive_version()
    assert info.dev_build is True, f"expected a dev build in a worktree, got {info}"


def test_git_describe_timeout_is_not_a_crash(tmp_path):
    def runner(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="git", timeout=5)

    assert git_describe(tmp_path, runner=runner) is None
