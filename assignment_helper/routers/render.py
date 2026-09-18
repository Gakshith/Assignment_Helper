"""Router: render. The document transport — snapshots over HTTP, deltas over WS.

Owned by the server strand. app.py (frozen) registers it under /api/render, so the
document transport lives at /api/render/* rather than /api/document/* — the document
router belongs to another strand and this one does not reach into it.

WHY THE TOKEN IS CHECKED IN HERE AND NOT LEFT TO THE MIDDLEWARE
--------------------------------------------------------------
security.py lists "/ws" in PROTECTED_PREFIXES and its docstring promises a token on
"every /api request and the WS handshake". LocalAuthMiddleware is a
starlette BaseHTTPMiddleware, and BaseHTTPMiddleware.__call__ begins:

    if scope["type"] != "http":
        await self.app(scope, receive, send)
        return

A WebSocket upgrade arrives with scope["type"] == "websocket", so the middleware hands
it straight to the app: NO Host allowlist, NO token check, NO rejection. The /ws prefix
in PROTECTED_PREFIXES is dead code for websockets. That is checked, not assumed —
tests/unit/test_ws_auth.py asserts the bypass exists at the middleware layer and that
this endpoint closes the hole anyway.

A security control that silently does not apply is worse than none, so the handshake
below re-implements all three defences for the websocket scope: Host allowlist (DNS
rebinding), Origin allowlist (the websocket analogue of Sec-Fetch-Site, which browsers
do not send on upgrades and which same-origin policy does not cover for WS), and the
session token. This has been reported to the lead as a contract bug against
security.py; nothing frozen was edited to work around it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket
from starlette.websockets import WebSocketDisconnect

from assignment_helper.document.schema import Delta, Snapshot
from assignment_helper.document.store import DeltaRejected, DocumentStore
from assignment_helper.security import SessionToken, allowed_hosts
from assignment_helper.server.ws import ConnectionHub, Role

router = APIRouter(prefix="/api/render", tags=["render"])

IMPLEMENTED = True

WS_POLICY_VIOLATION = 1008

# Allowed Origin values for the websocket upgrade, derived from the same port the
# middleware pins Host to.
_ORIGIN_SCHEMES = ("http", "https")


@router.get("/health")
async def health() -> dict[str, object]:
    return {"router": "render", "implemented": IMPLEMENTED}


def not_built(what: str) -> HTTPException:
    return HTTPException(
        status_code=501,
        detail={"code": "render.not-built", "message": f"{what} is not built yet."},
    )


# ---------------------------------------------------------------- wiring


def _store(app_state: Any) -> DocumentStore:
    store = getattr(app_state, "doc_store", None)
    if store is None:
        # Never an empty document standing in for a missing one (I5). A server without
        # a store is misconfigured and says exactly that.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "render.no-document",
                "message": (
                    "No document is open on this server. The CLI attaches the document "
                    "store at launch; this server was started without one."
                ),
            },
        )
    return store


def _hub(app_state: Any) -> ConnectionHub:
    hub = getattr(app_state, "hub", None)
    if hub is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "render.no-hub",
                "message": "The connection hub is not attached to this server.",
            },
        )
    return hub


def _coordinator(app_state: Any):
    coord = getattr(app_state, "file_coordinator", None)
    if coord is None:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "render.no-watcher",
                "message": (
                    "No file is being watched. The document was not opened from a path."
                ),
            },
        )
    return coord


def _rejected_detail(exc: DeltaRejected) -> dict[str, Any]:
    """Row: a rejected delta returns the CURRENT version, not a bare 500. The client
    needs to know what to resync to, and 409 is the accurate status for it."""
    return {
        "code": "delta.parent-mismatch",
        "message": (
            "This edit was based on an older version of the document and was rejected. "
            "Fetch a snapshot and try again."
        ),
        "parent_version": exc.parent_version,
        "current_version": exc.current_version,
    }


# ---------------------------------------------------------------- HTTP


@router.get("/snapshot")
async def get_snapshot(request: Request) -> Snapshot:
    return _store(request.app.state).snapshot()


@router.post("/delta")
async def post_delta(request: Request, delta: Delta) -> Snapshot:
    store = _store(request.app.state)
    try:
        snap = store.apply(delta)
    except DeltaRejected as exc:
        raise HTTPException(status_code=409, detail=_rejected_detail(exc)) from exc

    hub = getattr(request.app.state, "hub", None)
    if hub is not None:
        await hub.broadcast(
            {"type": "delta", "delta": delta.model_dump(mode="json"), "version": snap.version}
        )
    return snap


@router.get("/file/status")
async def file_status(request: Request) -> dict[str, Any]:
    return _coordinator(request.app.state).status()


@router.post("/file/reload")
async def file_reload(request: Request) -> Snapshot:
    """Row 16: the user clicked Reload. Only now may the document be replaced."""
    return _coordinator(request.app.state).reload_from_disk()


@router.post("/file/keep-mine")
async def file_keep_mine(request: Request) -> Snapshot:
    return _coordinator(request.app.state).keep_mine()


# ---------------------------------------------------------------- WS handshake auth


def authorize_websocket(
    *,
    headers: Any,
    query_token: str | None,
    token: SessionToken,
    port: int,
) -> tuple[str, str] | None:
    """Pure. Returns (code, message) to reject with, or None to accept.

    Re-implements, for the websocket scope, the three defences LocalAuthMiddleware
    applies only to the http scope. See this module's docstring.
    """
    hosts = allowed_hosts(port)

    host = headers.get("host", "")
    if host and host not in hosts:
        return (
            "auth.host-not-allowed",
            (f"Host {host!r} is not an allowed local host. "
            "This is the DNS-rebinding defence; it is working as intended."),
        )

    origin = headers.get("origin")
    if origin:
        allowed_origins = {f"{s}://{h}" for s in _ORIGIN_SCHEMES for h in hosts}
        if origin not in allowed_origins:
            # Same-origin policy does not restrict websocket connections, so a page on
            # any site can open one. Origin is the only thing that distinguishes it,
            # and it is the websocket analogue of the middleware's Sec-Fetch-Site rule.
            return (
                "auth.cross-origin-websocket",
                f"Origin {origin!r} may not open a websocket to this local server.",
            )

    presented = headers.get("x-ah-token") or query_token
    if not token.matches(presented):
        return (
            "auth.bad-token",
            ("Missing or invalid session token on the websocket handshake. Open the URL "
            "the CLI printed; the token is per-session and dies when the server stops."),
        )
    return None


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    state = websocket.app.state
    token: SessionToken | None = getattr(state, "token", None)
    config = getattr(state, "config", None)
    if token is None or config is None:
        await websocket.close(code=WS_POLICY_VIOLATION, reason="server not configured")
        return

    query_token = websocket.query_params.get("t")
    denial = authorize_websocket(
        headers=websocket.headers,
        query_token=query_token,
        token=token,
        port=config.port,
    )
    if denial is not None:
        code, message = denial
        # Accept-then-close so the browser sees a reason instead of a bare handshake
        # failure, which is indistinguishable from "the server is down" (I5).
        await websocket.accept()
        await websocket.send_json({"type": "denied", "code": code, "message": message})
        # The token is NOT echoed back in the denial. I16.
        await websocket.close(code=WS_POLICY_VIOLATION, reason=code)
        return

    client_id = websocket.query_params.get("client")
    if not client_id:
        await websocket.accept()
        await websocket.send_json(
            {
                "type": "denied",
                "code": "ws.no-client-id",
                "message": (
                    "The websocket handshake needs a per-tab ?client= id. It is what "
                    "lets a reconnecting tab reclaim ownership instead of being "
                    "treated as a second tab."
                ),
            }
        )
        await websocket.close(code=WS_POLICY_VIOLATION, reason="ws.no-client-id")
        return

    store = getattr(state, "doc_store", None)
    hub: ConnectionHub | None = getattr(state, "hub", None)
    if store is None or hub is None:
        await websocket.accept()
        await websocket.send_json(
            {
                "type": "denied",
                "code": "render.no-document",
                "message": "No document is open on this server.",
            }
        )
        await websocket.close(code=WS_POLICY_VIOLATION, reason="render.no-document")
        return

    await websocket.accept()
    admission = await hub.register(client_id, websocket)
    await websocket.send_json(hub.hello(client_id, store.version, admission))

    try:
        while True:
            message = await websocket.receive_json()
            await _handle_client_message(websocket, hub, store, client_id, message)
    except WebSocketDisconnect:
        pass
    finally:
        await hub.unregister(client_id)


async def _handle_client_message(
    websocket: WebSocket,
    hub: ConnectionHub,
    store: DocumentStore,
    client_id: str,
    message: Any,
) -> None:
    if not isinstance(message, dict):
        await websocket.send_json(
            {
                "type": "nack",
                "seq": None,
                "code": "ws.malformed",
                "message": "Expected a JSON object.",
            }
        )
        return

    kind = message.get("type")
    seq = message.get("seq")

    if kind == "ping":
        await websocket.send_json({"type": "pong", "seq": seq})
        return

    if kind != "delta":
        await websocket.send_json(
            {
                "type": "nack",
                "seq": seq,
                "code": "ws.unknown-type",
                "message": f"Unknown message type {kind!r}.",
            }
        )
        return

    if hub.role_of(client_id) is not Role.OWNER:
        # Row 15: the second tab is READ-ONLY. It is told so, by name, rather than
        # having its edit quietly disappear.
        await websocket.send_json(
            {
                "type": "nack",
                "seq": seq,
                "code": "ws.read-only",
                "message": (
                    f"This tab is read-only: tab {hub.registry.owner_client_id} is "
                    "editing this document."
                ),
                "owner_client_id": hub.registry.owner_client_id,
            }
        )
        return

    try:
        delta = Delta.model_validate(message.get("delta"))
    except Exception as exc:
        await websocket.send_json(
            {
                "type": "nack",
                "seq": seq,
                "code": "delta.invalid",
                "message": f"The delta did not validate: {exc}",
            }
        )
        return

    try:
        snap = store.apply(delta)
    except DeltaRejected as exc:
        await websocket.send_json(
            {
                "type": "nack",
                "seq": seq,
                **_rejected_detail(exc),
            }
        )
        return

    await websocket.send_json({"type": "ack", "seq": seq, "version": snap.version})
    await hub.broadcast(
        {"type": "delta", "delta": delta.model_dump(mode="json"), "version": snap.version}
    )
