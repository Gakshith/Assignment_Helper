"""I17: the serve and render paths never import the CV stack.

This is the test behind gate G13b. The CV stack costs 2.7 s on a cold filesystem
cache; the server must be answering requests in under five seconds. The import-linter
contract in pyproject.toml enforces the same rule statically — this file enforces it
dynamically, because the two catch different mistakes:

  * import-linter catches a static edge that nothing has executed yet.
  * this catches a module that actually lands in `sys.modules` at runtime, including
    via a path the static graph could not see.

Both are cheap and neither subsumes the other.
"""

from __future__ import annotations

import subprocess
import sys

FORBIDDEN = ("cv2", "skimage", "skan", "numba", "numpy")


def _imported_modules(statement: str) -> set[str]:
    """Import `statement` in a FRESH interpreter and report the top-level modules.

    A subprocess is essential: pytest has almost certainly imported numpy already via
    some other test, so asserting against this process's `sys.modules` would pass or
    fail depending on test ORDER, which is worse than not testing it.
    """
    code = (
        f"{statement}\n"
        "import sys\n"
        "print('\\n'.join(sorted({m.split('.')[0] for m in sys.modules})))\n"
    )
    out = subprocess.run(
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    return set(out.stdout.split())


def test_importing_the_app_does_not_pull_in_the_cv_stack() -> None:
    loaded = _imported_modules("import assignment_helper.app")
    leaked = sorted(set(FORBIDDEN) & loaded)
    assert not leaked, (
        f"assignment_helper.app imported {leaked}. I17 is broken and the server's "
        f"first launch now pays for the whole CV stack. Every cv2/skimage/numpy "
        f"import must sit inside a function body under assignment_helper/glyphs/**, "
        f"and routers/glyphs.py must reach those modules through importlib."
    )


def test_importing_the_glyphs_router_does_not_pull_in_the_cv_stack() -> None:
    """The router is the seam. It is registered by the frozen app.py at startup, so if
    it imports the CV stack eagerly the whole invariant is lost at the one place
    nobody looks."""
    loaded = _imported_modules("import assignment_helper.routers.glyphs")
    leaked = sorted(set(FORBIDDEN) & loaded)
    assert not leaked, f"assignment_helper.routers.glyphs imported {leaked}"


def test_the_cv_free_glyph_modules_stay_cv_free() -> None:
    """layout, charset, paths, errors and profile hold the pure logic and must stay
    importable without the CV stack — that is what lets the router name an error code
    without paying 2.7 s for it."""
    loaded = _imported_modules(
        "import assignment_helper.glyphs.layout, assignment_helper.glyphs.charset, "
        "assignment_helper.glyphs.paths, assignment_helper.glyphs.errors, "
        "assignment_helper.glyphs.profile"
    )
    leaked = sorted(set(FORBIDDEN) & loaded)
    assert not leaked, f"the CV-free glyph modules imported {leaked}"


def test_no_module_scope_cv_import_under_glyphs() -> None:
    """Read the source and assert every CV import is indented.

    A blunt check that reads the way the invariant is written, so a reviewer skimming
    the diff sees the rule restated in the place it applies.
    """
    import ast
    from pathlib import Path

    package = Path(__file__).resolve().parents[2] / "assignment_helper" / "glyphs"
    offenders: list[str] = []

    for source_file in sorted(package.glob("*.py")):
        tree = ast.parse(source_file.read_text(encoding="utf-8"))
        for node in tree.body:  # top level ONLY - that is the point
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module.split(".")[0]]
            for name in names:
                if name in FORBIDDEN:
                    offenders.append(f"{source_file.name}:{node.lineno} imports {name}")

    assert not offenders, "module-scope CV imports under glyphs/: " + "; ".join(offenders)
