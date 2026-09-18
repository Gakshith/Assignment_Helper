"""Local-server authentication. Invariant I16.

A localhost HTTP server with no auth is reachable by any page the user has open. This
is not theoretical: DNS rebinding turns "it only binds 127.0.0.1" into a same-origin
request from an attacker's page. Four defences, all cheap now and expensive to retrofit:

  1. Bind 127.0.0.1 only. Never 0.0.0.0.
  2. A random 32-byte per-session token on every /api request and the WS handshake.
  3. A Host allowlist — the DNS-rebinding defence proper. A rebound request arrives
     with the attacker's hostname in Host, so pinning Host to 127.0.0.1/localhost
     rejects it before the token is even considered.
  4. Reject Sec-Fetch-Site: cross-site on state-changing routes.

The token is never written to disk and never logged. It is delivered once in the
launch URL as ?t=, stripped immediately by the client with history.replaceState, and
held in sessionStorage — not in memory (F5 would log you out of your own app), not in
localStorage (it must die with the tab).
"""

from __future__ import annotations

import hmac
import secrets

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
PROTECTED_PREFIXES = ("/api", "/ws")


class SessionToken:
    """One token per server process. Generated at launch, never persisted."""

    def __init__(self) -> None:
        self._value = secrets.token_urlsafe(32)

    @property
    def value(self) -> str:
        return self._value

    def matches(self, presented: str | None) -> bool:
        if not presented:
            return False
        return hmac.compare_digest(presented, self._value)

    def __repr__(self) -> str:  # pragma: no cover - defensive
        return "<SessionToken redacted>"

    __str__ = __repr__


def allowed_hosts(port: int) -> frozenset[str]:
    return frozenset(
        {
            f"127.0.0.1:{port}",
            f"localhost:{port}",
            f"[::1]:{port}",
        }
    )


def _deny(code: str, message: str) -> JSONResponse:
    # Named, never generic. Invariant I5 applies to rejections too: a blank 403 during
    # development is indistinguishable from a bug in the client.
    return JSONResponse({"code": code, "message": message}, status_code=403)


class LocalAuthMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, token: SessionToken, port: int) -> None:
        super().__init__(app)
        self.token = token
        self.hosts = allowed_hosts(port)

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        host = request.headers.get("host", "")
        if host and host not in self.hosts:
            return _deny(
                "auth.host-not-allowed",
                f"Host {host!r} is not an allowed local host. "
                "This is the DNS-rebinding defence; it is working as intended.",
            )

        if not path.startswith(PROTECTED_PREFIXES):
            return await call_next(request)

        if request.method not in SAFE_METHODS:
            if request.headers.get("sec-fetch-site") == "cross-site":
                return _deny(
                    "auth.cross-site",
                    "A cross-site request tried to change local state and was rejected.",
                )

        presented = request.headers.get("x-ah-token") or request.query_params.get("t")
        if not self.token.matches(presented):
            return _deny(
                "auth.bad-token",
                "Missing or invalid session token. Open the URL the CLI printed; "
                "the token is per-session and dies when the server stops.",
            )

        return await call_next(request)
