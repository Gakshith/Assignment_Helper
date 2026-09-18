"""API key handling. Never committed, never logged, never in a traceback we construct.

Order of resolution, and it is deliberate:
  1. `ANTHROPIC_API_KEY` in the environment, when --no-keyring is active (I15 bypass).
  2. The macOS Keychain.
  3. The environment anyway, as a convenience for a user who never set up the Keychain.

Acceptance row 1: with no key at all the app must launch FULLY. Render, edit, restyle,
re-roll and export all work; only the AI panels are unreachable, and they say exactly
which command adds a key rather than showing a generic error.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

SERVICE = "assignment-helper"
ACCOUNT = "anthropic-api-key"

ADD_KEY_COMMAND = (
    f'security add-generic-password -s "{SERVICE}" -a "{ACCOUNT}" -w "sk-ant-..." -U'
)


@dataclass(frozen=True)
class KeyResult:
    key: str | None
    source: str

    @property
    def available(self) -> bool:
        return self.key is not None

    def __repr__(self) -> str:  # pragma: no cover - defensive
        return f"<KeyResult source={self.source} key={'set' if self.key else 'unset'}>"

    __str__ = __repr__


def resolve_key(*, use_keyring: bool = True) -> KeyResult:
    env = os.environ.get("ANTHROPIC_API_KEY") or None

    if not use_keyring:
        return KeyResult(env, "environment (--no-keyring)")

    try:
        import keyring

        stored = keyring.get_password(SERVICE, ACCOUNT)
    except Exception as exc:
        # NOT swallowed. A broken Keychain is a real condition the user must see,
        # and falling through to the environment silently would hide it (I5).
        print(f"[keys] Keychain unavailable ({type(exc).__name__}: {exc}); using the environment")
        stored = None

    if stored:
        return KeyResult(stored, "keychain")
    if env:
        return KeyResult(env, "environment")
    return KeyResult(None, "absent")
