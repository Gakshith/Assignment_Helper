"""THE SERVER. ***FROZEN.*** Do not modify on a strand branch.

Plan §3, the seam-freeze — the server-side twin of web/src/app/kernel.ts. Every router
is registered here UP FRONT against a stub module, and each Python strand owns exactly
one file in routers/. Two runtimes, so two convergence points.

A strand that believes it needs to edit this file is reporting a contract bug to the
lead, who amends it on `dev` and re-bases everyone. Nobody edits it in place.

I17: this module must never import cv2, skimage, skan, numba or numpy, directly or
transitively. The render and serve paths need none of them, and importing them at
module scope costs every launch ~450 ms and a first launch 2.7 s. Enforced by an
import-linter contract in pyproject.toml and measured by gate G13b.
"""

from __future__ import annotations

import socket
from dataclasses import dataclass
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from assignment_helper.routers import chat, document, export, glyphs, ingest, render, submit
from assignment_helper.security import LocalAuthMiddleware, SessionToken

STATIC_DIR = Path(__file__).parent / "static"

PORT_RANGE = range(7420, 7430)


@dataclass(frozen=True)
class ServerConfig:
    """Every active bypass is printed in the startup banner and badged in the UI, so you
    can never be unknowingly in one (invariant I15)."""

    port: int
    dev_build: bool = True
    offline: bool = False
    no_artifacts: bool = False
    dpi: int | None = None
    seed: int | None = None


def choose_port() -> int:
    """Acceptance row 22: probe, increment, refuse past the range with a message."""
    for port in PORT_RANGE:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(
        f"Every port in {PORT_RANGE.start}-{PORT_RANGE.stop - 1} is in use. "
        "Stop another assignment-helper instance, or pass --port."
    )


def create_app(config: ServerConfig, token: SessionToken) -> FastAPI:
    app = FastAPI(title="assignment-helper", docs_url=None, redoc_url=None, openapi_url=None)

    app.state.config = config
    # The token lives on app.state and is never logged, never persisted, never
    # serialised into a response body (invariant I16).
    app.state.token = token

    app.add_middleware(LocalAuthMiddleware, token=token, port=config.port)

    # EVERY router, registered here, once, in a fixed order. A strand fills in its own
    # file under routers/ and this list does not change.
    for module in (document, glyphs, render, chat, ingest, export, submit):
        app.include_router(module.router)

    @app.get("/api/status")
    async def status() -> dict[str, object]:
        return {
            "version": "0.1.0",
            "dev_build": config.dev_build,
            "port": config.port,
            "bypasses": {
                "offline": config.offline,
                "no_artifacts": config.no_artifacts,
                "dpi": config.dpi,
                "seed": config.seed,
            },
            "routers": {
                m.router.prefix.rsplit("/", 1)[-1]: m.IMPLEMENTED
                for m in (document, glyphs, render, chat, ingest, export, submit)
            },
        }

    if STATIC_DIR.joinpath("index.html").exists():
        app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

        @app.get("/")
        async def index() -> FileResponse:
            return FileResponse(STATIC_DIR / "index.html")

    else:

        @app.get("/")
        async def no_bundle() -> JSONResponse:
            # Never a blank page. A missing bundle is an installation fault and it says so.
            return JSONResponse(
                {
                    "code": "bundle.missing",
                    "message": (
                        "The web bundle is not built. Run `npm run build`, which writes "
                        "to assignment_helper/static/. A release wheel always contains it."
                    ),
                },
                status_code=500,
            )

    return app
