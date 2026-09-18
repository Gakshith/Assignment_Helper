"""The Anthropic client, with every timeout and failure mode the plan names.

Model: claude-opus-5, adaptive thinking. NOTE: `budget_tokens` is REJECTED with a 400
on Opus 5 — adaptive is the only correct form on this model. Streaming is used for
anything long, which is everything here.

Invariant I9, at the type level: nothing in this module accepts a glyph profile. The
payload builder takes document text, layout metrics and an optional image crop, and
there is no field through which handwriting data could travel even by mistake.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass, field

MODEL = "claude-opus-5"

REQUEST_TIMEOUT_S = 120.0   # I6
STREAM_STALL_S = 45.0       # I6: no chunk for this long ⇒ abort, keep partial, apply nothing
MAX_RETRIES = 3             # row 18
MAX_TOTAL_BACKOFF_S = 60.0  # row 18: the wait is BOUNDED and shown as a countdown
CONNECT_FAIL_VISIBLE_S = 3.0  # row 3: a DNS failure must surface in under 3 s

#  §C.6 derived the cap rather than inventing one: 3x the 90th-percentile observed
#  session cost, floor $5.00. The old $2.00 default was unmotivated and would trip
#  during ordinary testing on Opus 5 with adaptive thinking.
DEFAULT_SPEND_CAP_USD = 5.00


class LLMProblem(Exception):
    """A named failure. Never a bare 'something went wrong' (invariant I5)."""

    def __init__(self, code: str, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


class SpendCapExceeded(LLMProblem):
    pass


@dataclass
class Spend:
    """Tracked per session. The plan budgets $30-100 across M3-M5; that line item
    existed nowhere before §C.6 added it."""

    cap_usd: float = DEFAULT_SPEND_CAP_USD
    input_tokens: int = 0
    output_tokens: int = 0
    calls: int = 0
    #  Published rates change; this is a coarse guard rail, not an invoice.
    usd_per_mtok_in: float = 15.0
    usd_per_mtok_out: float = 75.0
    observed: list[float] = field(default_factory=list)

    @property
    def usd(self) -> float:
        return (
            self.input_tokens / 1_000_000 * self.usd_per_mtok_in
            + self.output_tokens / 1_000_000 * self.usd_per_mtok_out
        )

    def check(self) -> None:
        if self.usd >= self.cap_usd:
            raise SpendCapExceeded(
                "llm.spend-cap",
                f"This session has spent about ${self.usd:.2f}, at or over its "
                f"${self.cap_usd:.2f} cap. Raise it in settings to continue.",
            )

    def record(self, usage) -> None:
        self.calls += 1
        self.input_tokens += getattr(usage, "input_tokens", 0) or 0
        self.output_tokens += getattr(usage, "output_tokens", 0) or 0
        self.observed.append(self.usd)


@dataclass
class StreamEvent:
    kind: str          # "thinking" | "text" | "state" | "done"
    text: str = ""


class LLMClient:
    def __init__(self, api_key: str | None, *, offline: bool = False, spend: Spend | None = None):
        self._key = api_key
        self.offline = offline
        self.spend = spend or Spend()
        self._client = None

    @property
    def available(self) -> bool:
        """Acceptance row 1: with no key the app still launches fully; only AI is off."""
        return bool(self._key) and not self.offline

    def _ensure(self):
        if self.offline:
            raise LLMProblem(
                "llm.offline",
                "--offline is active, so no AI feature will contact the network.",
            )
        if not self._key:
            from assignment_helper.llm.keys import ADD_KEY_COMMAND

            raise LLMProblem(
                "llm.no-key",
                "No Anthropic API key is set. Everything except the AI features works.",
                detail=f"Add one with:\n  {ADD_KEY_COMMAND}",
            )
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic(
                api_key=self._key,
                timeout=REQUEST_TIMEOUT_S,
                #  Retries are handled here, visibly and with a bounded budget, rather
                #  than silently inside the SDK where the user cannot see the wait.
                max_retries=0,
            )
        return self._client

    def stream(self, *, system: str, messages: list[dict], max_tokens: int = 8000) -> Iterator[StreamEvent]:
        """Stream a turn. Yields thinking summaries first so gate G14 (first anything
        on screen ≤ 2.5 s) is reachable — adaptive thinking on Opus 5 puts first
        *content* many seconds out by design, and measuring that would fail on model
        behaviour rather than on anything we built."""
        import anthropic

        client = self._ensure()
        self.spend.check()

        backoff = 1.0
        waited = 0.0
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                yield StreamEvent("state", "contacting the model")
                last_chunk = time.monotonic()
                with client.messages.stream(
                    model=MODEL,
                    max_tokens=max_tokens,
                    system=system,
                    messages=messages,
                    thinking={"type": "adaptive"},
                ) as stream:
                    for event in stream:
                        now = time.monotonic()
                        if now - last_chunk > STREAM_STALL_S:
                            raise LLMProblem(
                                "llm.stream-stalled",
                                f"The model stopped sending data for {STREAM_STALL_S:.0f}s. "
                                "Nothing was applied to your document.",
                            )
                        last_chunk = now
                        etype = getattr(event, "type", "")
                        if etype == "thinking":
                            yield StreamEvent("thinking", getattr(event, "thinking", ""))
                        elif etype == "text":
                            yield StreamEvent("text", getattr(event, "text", ""))
                    final = stream.get_final_message()
                self.spend.record(final.usage)
                yield StreamEvent("done")
                return

            except anthropic.AuthenticationError as exc:
                #  Row 2: named "authentication", never "something went wrong". The key
                #  is marked invalid so the next click prompts instead of retrying.
                self._key = None
                raise LLMProblem(
                    "llm.authentication",
                    "The API key was rejected. Your document is unchanged.",
                    detail=str(exc),
                ) from exc

            except anthropic.APIConnectionError as exc:
                #  Row 3: offline surfaces fast. No 120 s hang on a DNS failure.
                raise LLMProblem(
                    "llm.offline-or-unreachable",
                    "Could not reach api.anthropic.com. Every local feature still works.",
                    detail=str(exc),
                ) from exc

            except anthropic.RateLimitError as exc:
                if attempt == MAX_RETRIES or waited >= MAX_TOTAL_BACKOFF_S:
                    raise LLMProblem(
                        "llm.rate-limited",
                        f"Rate limited after {attempt} attempts. Your document is unchanged.",
                        detail=str(exc),
                    ) from exc
                retry_after = float(getattr(exc, "response", None).headers.get("retry-after", backoff)) if getattr(exc, "response", None) else backoff
                wait = min(retry_after, MAX_TOTAL_BACKOFF_S - waited)
                #  Shown as a countdown, not a spinner (row 18).
                yield StreamEvent("state", f"rate limited, retrying in {wait:.0f}s")
                time.sleep(wait)
                waited += wait
                backoff *= 2
