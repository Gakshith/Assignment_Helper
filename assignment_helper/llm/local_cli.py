"""Talk to Claude through the `claude` CLI already installed on this machine.

**Why this exists.** The plan assumed one transport: an API key and an HTTPS call to
`api.anthropic.com`. That is not the only way a local-first tool can reach a model. If
the user already has Claude Code installed and signed in — and the kind of person who
runs this tool usually does — then the credential problem is already solved on their
machine, and asking for a second one is asking them to pay twice for the same thing.

So this is a peer of `LLMClient`, not a fallback: same `stream()` shape, same named
`LLMProblem` failures, chosen automatically when no API key is present and a working
`claude` binary is.

**What it costs.** No streaming of partial text — `claude -p` returns when it is done,
so the UI shows a "thinking" state and then the whole answer, and gate G14 (time to
first anything on screen) is met by the state line rather than by first token. No
token accounting either: the CLI bills against the user's own subscription and reports
no usage, so the spend cap simply does not apply. Both are stated in the startup banner
rather than discovered.

**Invariant I9 still holds.** The payload is the same `ChatPayload` content, which has
no field a glyph profile can travel through. The prompt goes to a local process over a
pipe, which then makes its own call; nothing here writes the user's handwriting to disk
or to the network.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from collections.abc import Iterator

from assignment_helper.llm.client import LLMProblem, StreamEvent

#: The CLI can take a while on a long solve; this is the same ceiling as the HTTP path.
TIMEOUT_S = 180.0


def find_claude() -> str | None:
    """The `claude` binary, or None.

    `shutil.which` misses it when the app is launched from a GUI context, where PATH is
    the login shell's and not the terminal's — so the usual install location is checked
    explicitly rather than reporting "not installed" to someone who has it.
    """
    found = shutil.which("claude")
    if found:
        return found
    fallback = os.path.expanduser("~/.local/bin/claude")
    return fallback if os.path.isfile(fallback) and os.access(fallback, os.X_OK) else None


class LocalClaudeClient:
    """A drop-in peer of `LLMClient` backed by the local CLI."""

    def __init__(self, *, offline: bool = False, binary: str | None = None) -> None:
        self.offline = offline
        self._binary = binary or find_claude()

    @property
    def available(self) -> bool:
        return self._binary is not None and not self.offline

    @property
    def transport(self) -> str:
        return f"claude CLI ({self._binary})" if self._binary else "claude CLI (not found)"

    def stream(
        self, *, system: str, messages: list[dict], max_tokens: int = 8000
    ) -> Iterator[StreamEvent]:
        if self.offline:
            raise LLMProblem(
                "llm.offline", "--offline is active, so no AI feature will contact the network."
            )
        if not self._binary:
            raise LLMProblem(
                "llm.no-claude-cli",
                "The `claude` command was not found, and no API key is set.",
                detail="Install Claude Code, or add a key to the Keychain. Everything "
                "except the AI features works either way.",
            )

        prompt = _flatten(system, messages)

        yield StreamEvent("state", "asking the local claude…")
        try:
            done = subprocess.run(
                [self._binary, "-p"],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=TIMEOUT_S,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise LLMProblem(
                "llm.cli-timeout",
                f"The local claude did not answer within {TIMEOUT_S:.0f}s. "
                "Your document is unchanged.",
            ) from exc
        except OSError as exc:
            raise LLMProblem(
                "llm.cli-unavailable",
                f"Could not run {self._binary}: {exc}. Your document is unchanged.",
            ) from exc

        if done.returncode != 0:
            # stderr, not a generic message: the CLI says useful things there, like
            # being signed out, and hiding them sends the user looking in the app.
            raise LLMProblem(
                "llm.cli-failed",
                f"The local claude exited {done.returncode}. Your document is unchanged.",
                detail=(done.stderr or "").strip()[:500],
            )

        text = (done.stdout or "").strip()
        if not text:
            raise LLMProblem(
                "llm.cli-empty", "The local claude returned nothing. Your document is unchanged."
            )

        yield StreamEvent("text", text)
        yield StreamEvent("done")


def _flatten(system: str, messages: list[dict]) -> str:
    """Anthropic message blocks -> one prompt string.

    Images are NAMED, not inlined: `claude -p` takes text on stdin, and base64 in a
    prompt is megabytes of noise that would crowd out the question. Losing the image is
    a real capability difference from the HTTP path and the prompt says so plainly, so
    the model answers about the text rather than inventing a description of a picture
    it cannot see.
    """
    parts: list[str] = []
    if system:
        parts.append(system.strip())

    for message in messages:
        content = message.get("content", "")
        if isinstance(content, str):
            parts.append(content)
            continue
        for block in content:
            if block.get("type") == "text":
                parts.append(block.get("text", ""))
            elif block.get("type") == "image":
                parts.append(
                    "[An image of the page was attached, but this transport cannot "
                    "carry images. Answer from the text above only, and say so if the "
                    "question needs the picture.]"
                )

    return "\n\n".join(p for p in parts if p).strip()


def describe_choice(api_key_present: bool, cli: str | None) -> str:
    """One line for the startup banner. Which transport, and what it costs."""
    if api_key_present:
        return "AI: Anthropic API (key from the Keychain)"
    if cli:
        return f"AI: local claude CLI — no API key needed, no images, no spend cap ({cli})"
    return "AI: unavailable — no API key and no `claude` command. Everything else works."


def _json_probe(binary: str) -> dict:  # pragma: no cover - diagnostic helper
    """Used by --selftest to prove the CLI answers before the user needs it to."""
    done = subprocess.run(
        [binary, "-p", "--output-format", "json"],
        input="Reply with exactly: OK",
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    try:
        return json.loads(done.stdout)
    except json.JSONDecodeError:
        return {"raw": done.stdout[:200], "returncode": done.returncode}
