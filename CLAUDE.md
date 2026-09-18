# Assignment_Helper — repo notes

Build commands, architecture and conventions for this repo only.
Workspace rules live in the root schema; nothing here restates them.

## Status

Seam-freeze landed on `dev`. `web/src/app/kernel.ts` and `assignment_helper/app.py` are
**frozen** and wired against stubs. Strands branch from the freeze commit; see §3 of the
build plan. Milestone ladder M0–M5 (plan §C.1) replaces the old phase order.

## Build and test

```bash
uv venv --python 3.14 .venv && uv pip install --python .venv/bin/python -e '.[dev]'
npm install

.venv/bin/python -m pytest tests -q          # Python
npx vitest run --config vitest.config.ts     # TypeScript
npx tsc --noEmit                             # types
.venv/bin/python scripts/gen_types.py        # regenerate document.d.ts after a schema change
npm run build                                # bundle -> assignment_helper/static/ (never dist/)
```

Python 3.14.5 verified working with the whole pinned stack (2026-09-17). `watchfiles`
was dropped: no cp314 wheel, falls back to a Rust build. File watching is a stdlib
mtime poll instead — per the fallback doctrine, drop the dependency rather than move
the Python pin.

## Architecture

**The document is the source of truth; the rendered image is a disposable view.**
Never edit pixels, never OCR our own output. Any feature that wants to change the page
changes the document and re-renders.

```
render(Document, Style, seed) -> Page
```

Pure and deterministic. **Seeds live on blocks, not on the page** — a page-level seed
would re-roll the whole page on every edit and break block isolation (I3).

Block types: `Prose`, `Math` (LaTeX), `Diagram`, `Boxed`, `Spacer`.

**The browser is the only renderer.** Python does glyph extraction (once per profile)
and the export artifact pass. Python never draws ink. There is no second rasterizer and
no Python port of the paint path; if Canvas2D disappoints, the next step is WebGL2 in
the same browser.

**Outline-first (plan §C.1).** v1 uses glyph OUTLINES, not centerlines. There is no
stroke, no pressure and no per-instance width until M5. A "variant" is a fixed affine
perturbation of an outline chosen by the counter-based RNG.

## Module boundaries — owned / forbidden

| Module | Runtime | Owns | Must not know about / import |
|---|---|---|---|
| `document` | Py + TS (generated) | block model, ops, versioning, serialisation, migrations | rendering, canvas, fonts, LLM, HTTP |
| `glyphs` (extract) | Python | sheet PDF, rectify, segment, outline extraction, profile write | layout, paper, the LLM |
| `glyphstudio` | TS | inspector UI, repair gestures, live pointer capture | layout, paper, PDF, chat |
| `render/layout` | TS | line breaking, pagination, KaTeX walk, glyph placement → **geometry JSON** | canvas, paper texture, ink, DOM, PDF |
| `render/paint` | TS | outline drawing, jitter, drift, slant, ink compositing, outline cache | document semantics, LaTeX, paper params beyond a surface handle |
| `render/paper` | TS | procedural noise, ruling/grid, tint, aging, cached base layer | glyphs, layout, ink |
| `render/figures` | TS | diagram primitives → sketchy strokes | document, paper, chat |
| `render/rng`, `render/units` | TS | counter-based PRNG; mm↔px | **everything — leaf modules, zero imports** |
| `export` | TS + Py | worker rasterize loop, raw POST; Python artifacts + PDF | document semantics, LLM, glyph extraction |
| `llm` | Python | Anthropic client, streaming, prompts, structured-edit schemas, key handling | rendering, glyph data (**type-level**, see I9) |
| `ingest` | Python | markdown/text → Document; screenshot → Document via vision | rendering, export |
| `submit` | Python | Canvas API, file handoff, reveal-in-Finder | rendering |
| `server` | Python | CLI, HTTP, WS, file watch, session store, router registration | every module above except through its router |

## Frozen files — do not edit on a strand branch

- `web/src/app/kernel.ts` — the client kernel, where four strands converge
- `web/src/app/contracts.ts` — every client seam declared
- `web/src/render/geometry.ts` — the layout↔paint contract
- `assignment_helper/app.py` — router registration, its server-side twin
- `assignment_helper/document/schema.py` → generated `web/src/types/document.d.ts`

A strand that believes it needs to change one of these is reporting a contract bug to
the lead. The lead amends it on `dev` and re-bases everyone. Nobody edits in place.

## Conventions

- **Handwriting *samples* never leave the machine, and never enter git.** The precise
  claim (I9): the tracing sheet, the extracted glyph profile and the font are never
  transmitted and never committed; rendered output is the user's document and is sent
  only when the user asks a question about it. The repo is public — fixtures use the
  OFL reference hand, never the user's.
- All render geometry is in **millimetres** (I8). No pixel literals. One scale applied
  at the canvas boundary.
- **No silent failure** (I5). Every subsystem failure becomes a typed `Problem` that
  reaches the UI. No `except: pass`, no empty `catch`, no `|| default` that hides a throw.
- **I17**: `cv2`, `skimage`, `skan`, `numba`, `numpy` may be imported only inside
  function bodies under `assignment_helper/glyphs/**`. Enforced by import-linter.
- Platform integrations are tiered. Tier 1 = official API (Canvas only). Tier 3 =
  screenshot in, manual upload out. **Tier 2 (browser automation / scraping) is
  deliberately not built** — Gradescope's terms prohibit it and Expert TA has no
  content API at all. Don't add it without an explicit decision to revisit.
- API keys come from the Keychain or the environment, never committed.
- Plain commit messages. No `Co-Authored-By` trailer, no "Generated with" line.

## Known risk

Math layout was the #1 risk and is **retired by spike**: KaTeX's `__renderToDomTree`
returns a positioned box tree with TeX metrics, and `__setFontMetrics` makes our hand
drive the layout. The private entry points are the exposure — `katex` is pinned exactly
and a permanent test asserts `__parse`, `__renderToDomTree` and `__setFontMetrics` all
still exist and that `__setFontMetrics` still moves the root box height.
