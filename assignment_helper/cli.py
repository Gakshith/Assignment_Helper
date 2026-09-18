"""The entry point. `assignment-helper hw7.md`, `assignment-helper --selftest`.

argparse, deliberately. A CLI framework would be a dependency for two subcommands.

INVARIANT I15: EVERY ACTIVE BYPASS IS PRINTED IN THE STARTUP BANNER. Not a debug flag,
not a verbose mode - always, on every launch. The point is that you can never be
unknowingly in one, and the failure this prevents is spending an afternoon debugging
output that was rendered with --dpi 72 or a pinned --seed.

INVARIANT I16: the session token is never written to disk and never logged. It is
handed to the browser in the launch URL and appears nowhere else. The banner prints the
bare URL. The ONLY place the tokenised URL is printed is the fallback when the browser
could not be opened at all, where the alternative is an app the user cannot reach; that
line is marked, and --print-url makes it explicit for headless use.

I17: this module must never import cv2, skimage, skan, numba or numpy. Glyph extraction
is M2 and lives behind assignment_helper/glyphs/**; --selftest deliberately does NOT
check for the CV stack, because checking would mean importing it.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import platform
import sys
import threading
import tomllib
import webbrowser
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from importlib import metadata
from pathlib import Path
from typing import Any

import uvicorn

from assignment_helper.app import PORT_RANGE, STATIC_DIR, ServerConfig, choose_port, create_app
from assignment_helper.security import SessionToken
from assignment_helper.server.watch import POLL_INTERVAL_S, DocumentFileCoordinator, FileWatcher
from assignment_helper.server.ws import ConnectionHub
from assignment_helper.version import DIST_NAME, VersionInfo, derive_version

HOST = "127.0.0.1"  # Never 0.0.0.0. Not behind a flag, not for a demo.

RED = "\033[31m"
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------- selftest


@dataclass
class SelfTestResult:
    failures: list[str] = field(default_factory=list)
    checks: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures


def read_pins(root: Path | None = None) -> dict[str, str]:
    """The exact pins, from pyproject.toml in a source tree or from the installed
    distribution's Requires-Dist in a wheel. Optional extras are excluded: the CV stack
    is not installed for a normal run and asserting it would be wrong (I17)."""
    root = root or _repo_root()
    pyproject = root / "pyproject.toml"
    if pyproject.exists():
        data = tomllib.loads(pyproject.read_text(encoding="utf-8"))
        raw = data.get("project", {}).get("dependencies", [])
    else:
        raw = [r for r in (metadata.requires(DIST_NAME) or []) if "extra ==" not in r]

    pins: dict[str, str] = {}
    for requirement in raw:
        spec = requirement.split(";", 1)[0].strip()
        if "==" not in spec:
            continue
        name, _, version = spec.partition("==")
        pins[name.strip()] = version.strip()
    return pins


def installed_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def check_pins(
    pins: dict[str, str],
    lookup: Callable[[str], str | None] = installed_version,
) -> list[str]:
    """Pure. Returns one loud line per mismatch, NAMING what was expected."""
    failures: list[str] = []
    for name, expected in sorted(pins.items()):
        found = lookup(name)
        if found is None:
            failures.append(f"{name}: expected =={expected}, but it is NOT INSTALLED")
        elif found != expected:
            failures.append(f"{name}: expected =={expected}, found =={found}")
    return failures


def run_selftest(
    root: Path | None = None,
    *,
    machine: str | None = None,
    static_dir: Path | None = None,
    lookup: Callable[[str], str | None] = installed_version,
) -> SelfTestResult:
    root = root or _repo_root()
    static_dir = static_dir or STATIC_DIR
    result = SelfTestResult()

    arch = machine or platform.machine()
    if arch != "arm64":
        result.failures.append(
            f"architecture: expected arm64 (Apple silicon), found {arch!r}. "
            "The pinned wheels are arm64; an x86_64 interpreter under Rosetta will "
            "install different binaries and render differently."
        )
    else:
        result.checks.append(f"architecture is {arch}")

    pins = read_pins(root)
    if not pins:
        result.failures.append(
            "pinned dependencies: could not read any == pins from pyproject.toml or "
            "the installed distribution metadata. The install is not verifiable."
        )
    else:
        pin_failures = check_pins(pins, lookup)
        result.failures.extend(f"dependency {line}" for line in pin_failures)
        result.checks.append(f"{len(pins) - len(pin_failures)}/{len(pins)} pinned versions exact")

    index = static_dir / "index.html"
    if not index.exists():
        result.failures.append(
            f"web bundle: expected {index} to exist, and it does not. "
            "Run `npm run build`, which writes to assignment_helper/static/. "
            "A release wheel always contains it."
        )
    else:
        result.checks.append(f"web bundle present at {index}")

    return result


def print_selftest(result: SelfTestResult, version: VersionInfo, colour: bool) -> int:
    red = RED if colour else ""
    bold = BOLD if colour else ""
    reset = RESET if colour else ""

    print(f"assignment-helper {version.version}  ({version.note})")
    for line in result.checks:
        print(f"  ok    {line}")
    for line in result.failures:
        print(f"{red}  FAIL  {line}{reset}")
    if result.ok:
        print(f"{bold}selftest passed{reset}")
        return 0
    print(f"{red}{bold}selftest FAILED: {len(result.failures)} problem(s) above.{reset}")
    return 1


# ---------------------------------------------------------------- banner


def active_bypasses(args: argparse.Namespace, extra: Sequence[str] = ()) -> list[str]:
    """I15. Every one of these, every launch, in the banner."""
    bypasses: list[str] = []
    if args.no_artifacts:
        bypasses.append("--no-artifacts       export artifacts are not written")
    if args.dpi is not None:
        bypasses.append(f"--dpi {args.dpi:<15} render DPI is forced, not taken from the style")
    if args.seed is not None:
        bypasses.append(f"--seed {args.seed:<14} the RNG is pinned; output is not the usual hand")
    if args.no_keyring:
        bypasses.append("--no-keyring         API keys come from the environment, not the Keychain")
    if args.offline:
        bypasses.append("--offline            the LLM is not contacted")
    if args.browser:
        bypasses.append(f"--browser {args.browser:<11} a non-default browser is opened")
    bypasses.extend(extra)
    return bypasses


def banner(
    version: VersionInfo,
    config: ServerConfig,
    document_path: Path | None,
    bypasses: Sequence[str],
    *,
    colour: bool,
    print_url: bool = False,
) -> str:
    red = RED if colour else ""
    bold = BOLD if colour else ""
    dim = DIM if colour else ""
    reset = RESET if colour else ""

    lines = [f"{bold}assignment-helper {version.version}{reset}"]
    if version.dev_build:
        # A release build prints none of this.
        lines.append(f"{red}{bold}  !!  DEVELOPMENT BUILD  !!{reset}")
        lines.append(f"{red}      {version.note}{reset}")
        if version.dirty:
            lines.append(f"{red}      the working tree has uncommitted changes{reset}")
    lines.append(f"  document   {document_path if document_path else '(none)'}")
    lines.append(f"  server     http://{HOST}:{config.port}/")
    token_note = (
        "(the session token is printed below: --print-url)"
        if print_url
        else "(the session token is sent to the browser, never printed)"
    )
    lines.append(f"{dim}             {token_note}{reset}")
    if bypasses:
        lines.append(f"{bold}  bypasses{reset}")
        for item in bypasses:
            lines.append(f"    {item}")
    else:
        lines.append("  bypasses   none")
    return "\n".join(lines)


# ---------------------------------------------------------------- wiring


def load_source(path: Path) -> Any:
    """A file on disk -> a Document. This is the product's primary input path.

    Plan §C.5.1: a red-team found that nothing anywhere parsed a file from disk while
    the CLI's own example was `assignment-helper hw7.md`. It is wired HERE, explicitly,
    so that it cannot quietly stop being used.
    """
    from assignment_helper.ingest.markdown import parse_markdown

    text = path.read_text(encoding="utf-8")
    return parse_markdown(text, doc_id=path.stem, source_path=str(path))


def store_path_for(path: Path) -> Path:
    """`<name>.ah.json` beside the user's source file.

    It is the user's work: it belongs in their Time Machine and is diffable in git.
    """
    if path.suffix == ".json" and path.name.endswith(".ah.json"):
        return path
    return path.with_name(f"{path.stem}.ah.json")


def build_store(path: Path) -> tuple[Any, Callable[[Path], Any], list[str]]:
    """Returns (store, loader, bypass lines).

    These imports are DELIBERATELY UNGUARDED. An earlier version guarded them with
    `except ImportError` and fell back to an in-memory store and a plain-text loader,
    because at the time the strand was written neither module existed yet. Once both
    landed, that guard became the bug it was meant to prevent: `load_document` was never
    a real name in `ingest.markdown`, so the import always failed, the CLI always took
    the fallback, and the markdown parser - the whole of §C.5.1 - was dead code in the
    shipped product. The bypass banner made it visible rather than silent, which is the
    only reason it was survivable.

    Both modules ship inside this same wheel. If either is missing, that is an
    installation fault and it must be LOUD, not routed around.
    """
    from assignment_helper.document.filestore import FileDocumentStore

    ah_path = store_path_for(path)
    if ah_path.exists():
        # Migrates forward, or raises DocumentTooNew naming the .bak-v<n> and the
        # command to restore it (acceptance row 10).
        store = FileDocumentStore.open(ah_path)
    else:
        store = FileDocumentStore.create(ah_path, load_source(path))

    return store, load_source, []


def attach(
    app: Any,
    store: Any,
    path: Path | None,
    loader: Callable[[Path], Any],
    llm_client: Any,
    *,
    watch_interval_s: float = POLL_INTERVAL_S,
) -> ConnectionHub:
    """Everything app.py (frozen) does not do, done from out here."""
    # Register the store with the routers that serve it. Two strands built these halves
    # in parallel against the frozen DocumentStore Protocol; the Protocol fixed the
    # store's SHAPE but nothing declared who calls the registrar, so the CLI opened a
    # document and every /api/document route still answered "no document is open".
    # The seam-freeze covered the interface and missed the wiring.
    from assignment_helper.routers.chat import set_llm_client
    from assignment_helper.routers.document import set_document_store

    set_document_store(app, store)

    # Registered here, in the same place and at the same time as the store, because
    # the last wave lost an entire subsystem to a registrar that one strand wrote and
    # another never called. Both registrars now live on one screen.
    set_llm_client(app, llm_client)

    hub = ConnectionHub()
    app.state.doc_store = store
    app.state.hub = hub

    if path is not None:

        def notify(message: dict[str, Any]) -> None:
            hub.dispatch_threadsafe(message)

        coordinator = DocumentFileCoordinator(path, store, loader, notify)

        def on_error(exc: BaseException) -> None:
            # I5: a watcher thread that dies silently looks exactly like a file that
            # never changes. Say so, and keep polling.
            print(f"[watch] {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            # NOT an I5 violation, and spelled out so a reader can tell the difference:
            # the stderr line above is the primary, unconditional record. This second
            # channel is a best-effort push to a UI that may not be listening yet (no
            # running event loop raises RuntimeError). Losing it loses no information.
            with contextlib.suppress(RuntimeError):
                hub.dispatch_threadsafe(
                    {
                        "type": "problem",
                        "problem": {
                            "scope": "app",
                            "code": "watch.failed",
                            "message": "Could not check the source file for changes.",
                            "detail": f"{type(exc).__name__}: {exc}",
                        },
                    }
                )

        watcher = FileWatcher(
            path,
            lambda _p: coordinator.on_disk_change(),
            on_error=on_error,
            interval_s=watch_interval_s,
        )
        app.state.file_coordinator = coordinator
        app.state.file_watcher = watcher

    async def _startup() -> None:
        await hub.start()
        watcher_ = getattr(app.state, "file_watcher", None)
        if watcher_ is not None:
            watcher_.start()

    async def _shutdown() -> None:
        watcher_ = getattr(app.state, "file_watcher", None)
        if watcher_ is not None:
            watcher_.stop()
        await hub.stop()

    # Starlette 1.x removed FastAPI.add_event_handler. The router's on_startup /
    # on_shutdown lists are still the supported way to register a lifecycle hook from
    # OUTSIDE app construction, which is what this needs: create_app() is frozen
    # (plan §3) and takes no lifespan argument. Deliberately not app.on_event, which
    # is deprecated and emits a warning on every launch.
    app.router.on_startup.append(_startup)
    app.router.on_shutdown.append(_shutdown)
    return hub


def open_browser(url: str, browser: str | None, *, opener=webbrowser) -> bool:
    """The tokenised URL goes HERE and nowhere else (I16)."""
    try:
        controller = opener.get(browser) if browser else opener
        return bool(controller.open(url))
    except Exception as exc:
        print(f"could not open a browser: {type(exc).__name__}: {exc}", file=sys.stderr)
        return False


# ---------------------------------------------------------------- argparse


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="assignment-helper",
        description="Render a document as handwriting on paper, then print or submit it.",
    )
    parser.add_argument("document", nargs="?", help="the source file to open, e.g. hw7.md")
    parser.add_argument(
        "--selftest",
        action="store_true",
        help="verify the install (architecture, exact dependency pins, web bundle) and exit",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help=f"bind a specific port instead of probing {PORT_RANGE.start}-{PORT_RANGE.stop - 1}",
    )
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    parser.add_argument(
        "--print-url",
        action="store_true",
        help="print the tokenised URL to stdout (headless use; it is normally withheld)",
    )

    bypass = parser.add_argument_group("bypasses (each one is printed in the startup banner)")
    bypass.add_argument("--no-artifacts", action="store_true", help="do not write export artifacts")
    bypass.add_argument("--dpi", type=int, default=None, help="force a render DPI")
    bypass.add_argument("--seed", type=int, default=None, help="pin the RNG seed")
    bypass.add_argument(
        "--no-keyring", action="store_true", help="read API keys from the environment only"
    )
    bypass.add_argument("--offline", action="store_true", help="never contact the LLM")
    bypass.add_argument("--browser", default=None, help="open a named browser instead of the default")
    return parser


# ---------------------------------------------------------------- main


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    colour = sys.stdout.isatty()
    version = derive_version()

    if args.selftest:
        return print_selftest(run_selftest(), version, colour)

    if not args.document:
        parser.error("a document is required, e.g. `assignment-helper hw7.md` (or --selftest)")

    path = Path(args.document).expanduser().resolve()
    if not path.exists():
        print(f"{RED if colour else ''}no such file: {path}{RESET if colour else ''}", file=sys.stderr)
        return 2

    try:
        port = args.port if args.port is not None else choose_port()
    except RuntimeError as exc:
        # Acceptance row 22: refuse with a message, never crawl off the range.
        print(f"{RED if colour else ''}{exc}{RESET if colour else ''}", file=sys.stderr)
        return 3

    config = ServerConfig(
        port=port,
        dev_build=version.dev_build,
        offline=args.offline,
        no_artifacts=args.no_artifacts,
        dpi=args.dpi,
        seed=args.seed,
    )
    token = SessionToken()
    app = create_app(config, token)

    store, loader, seam_bypasses = build_store(path)
    from assignment_helper.llm.client import LLMClient
    from assignment_helper.llm.keys import resolve_key

    key = resolve_key(use_keyring=not args.no_keyring)
    llm_client = LLMClient(key.key, offline=args.offline)
    attach(app, store, path, loader, llm_client)

    print(
        banner(
            version,
            config,
            path,
            active_bypasses(args, seam_bypasses),
            colour=colour,
            print_url=args.print_url,
        ),
        flush=True,
    )

    url = f"http://{HOST}:{port}/?t={token.value}"
    if args.print_url:
        # flush=True matters: the server below never returns, so an unflushed stdout
        # buffer holds this line forever and --print-url silently does nothing.
        print(f"  url        {url}", flush=True)

    if not args.no_browser:
        def launch() -> None:
            if not open_browser(url, args.browser):
                # The app is unreachable without this, so it is the one place the
                # tokenised URL is printed. Marked, so it is never mistaken for routine.
                print(
                    "  could not open a browser. Open this URL yourself "
                    "(it carries this session's token):\n"
                    f"  {url}",
                    file=sys.stderr,
                    flush=True,
                )

        threading.Timer(0.6, launch).start()

    server = uvicorn.Server(
        uvicorn.Config(app, host=HOST, port=port, log_level="warning", access_log=False)
    )
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(server.serve())
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
