# Assignment_Helper — repo notes

Build commands, architecture and conventions for this repo only.
Workspace rules live in the root schema; nothing here restates them.

## Status

No code yet. Vision stage — see `VISION.md`. There is nothing to build or test.

## Architecture (intended)

**The document is the source of truth; the rendered image is a disposable view.**
Never edit pixels, never OCR our own output. Any feature that wants to change the page
changes the document and re-renders.

```
render(Document, Style, seed) -> Page
```

Pure and deterministic: same document + style + seed always produces the same page.
A new seed produces a differently-imperfect page. Nothing in the render path may read
wall-clock time or unseeded randomness — that would break re-render stability and make
the canvas editor flicker on every keystroke.

Block types: `Prose`, `Math` (LaTeX), `Diagram` (declarative spec), `Boxed`, `Spacer`.

## Planned module boundaries

| Module | Owns | Must not know about |
|---|---|---|
| `document` | block model, serialization | rendering, fonts, LLM |
| `glyphs` | sheet segmentation, vectorization, font build | layout, paper |
| `layout` | line breaking, math tree → glyph placement | paper texture, PDF |
| `paint` | jitter, ink weight, stroke rendering | document semantics |
| `paper` | surfaces, textures, scan/compression pass | glyphs, layout |
| `figures` | diagram spec → sketchy primitives | document, paper |
| `ingest` | screenshot/paste/API → Document | rendering |
| `submit` | Canvas API, PDF assembly, file handoff | rendering |
| `server` | CLI, local HTTP + WebSocket, file watch | everything above, via interfaces only |

The handwriting backend sits behind an interface so an ML style backend (One-DM,
DiffusionPen) can slot in later for prose without touching layout, paper or PDF.

## Conventions

- Handwriting samples and built fonts never leave the machine. No upload, no telemetry,
  no third-party font service. This constrains real design choices — don't relax it.
- API keys come from the environment or a local config file, never committed.
- Platform integrations are tiered. Tier 1 = official API (Canvas only). Tier 3 =
  screenshot in, manual upload out. **Tier 2 (browser automation / scraping) is
  deliberately not built** — Gradescope's terms prohibit it and Expert TA has no
  content API at all. Don't add it without an explicit decision to revisit.

## Known risk

Hand-drawn math layout (spacing classes, delimiter stretching, sub/superscript
positioning, nested fractions) has no off-the-shelf solution — no public weights exist
for handwritten-math generation. Prototype this before trusting anything built on it.
