# Assignment_Helper

**A handwritten-page engine.** Content goes in — solved problems, notes, derivations,
prose. A page comes out that reads as genuinely handwritten, in your own hand, on the
paper you chose, and it stays editable the whole way.

Read [VISION.md](./VISION.md) for the full picture.

## Why

Some courses permit AI assistance *and* require submissions as a PDF of handwritten
pages. Those two rules aren't in conflict — one governs how you may think, the other
governs what format you submit in — but no tool sits in the gap. So the work gets done
with AI and then transcribed by hand for forty minutes purely to satisfy a file format.

That transcription is the only step in the pipeline a machine currently can't do.
This is that missing renderer.

It is subject-agnostic. Solving the assignment is generic agent work; the render is
the product. Physics is the first subject through the door, not the category.

## How it works

The image is a view; the document is the truth. A structured document of typed blocks
(prose, LaTeX math, diagram specs, boxed answers) is rendered by a pure function of
document + style + seed. Editing, AI chat, restyling, re-rolling one equation and PDF
export all fall out of that one decision.

Handwriting comes from glyph **outlines**. v1 ships with a licensed reference hand and
renders immediately with no setup; from M2 you fill a tracing sheet once, photograph it,
and the pipeline rectifies and segments each cell into several variants per character.
Rendering applies per-instance affine jitter, dual-frequency baseline drift, slant drift
and variant rotation so it never reads as a font. Pressure taper and per-instance stroke
width are deliberately out of v1 — see the milestone ladder in the build plan.

## Privacy — the precise claim

Stated exactly, because the loose version of this sentence is false and it matters:

> **The tracing sheet, the extracted glyph profile and the font are never transmitted
> and never committed.** They do not leave the machine, and they never enter this
> repository, which is public.
>
> **Rendered output is your document.** It is sent only when you ask a question about it
> — asking the AI about a selection may include an image crop of the rendered page, and
> a rendered page is a picture of your handwriting. That is a choice you make per
> question, not a background upload.

There is no telemetry, no crash reporting and no third-party font service. The only
outbound host the application ever contacts is `api.anthropic.com`, and only when you
use an AI feature. `--offline` disables every AI feature; everything else still works.

## Status

**In build.** The seam-freeze has landed on `dev`: the client kernel, the server, the
document schema and the cross-language RNG are frozen contracts, and the milestones are
being built against them in parallel. Nothing is installable yet.

## Run it

Not yet installable. From a checkout, on macOS with Python 3.14:

```bash
uv venv --python 3.14 .venv
uv pip install --python .venv/bin/python -e '.[dev]'
npm install && npm run build
.venv/bin/python -m assignment_helper.cli hw7.md
```

The CLI starts a local server bound to `127.0.0.1` only and opens a browser tab. Every
request carries a per-session token that is never written to disk; the server also pins
the `Host` header, which is the defence against DNS rebinding turning "it only listens on
localhost" into a same-origin request from someone else's page.

## Scope

This exists for courses that permit AI and require a handwritten format. It reproduces
your own hand from your own samples. It will not gain a feature for imitating anyone
else's handwriting, and it does not automate access to platforms whose terms prohibit
it — Canvas has a documented API and is supported properly; everywhere else is
screenshot in, PDF out, and you do the upload.

## License

Not yet chosen. The bundled reference handwriting font is third-party and ships under
its own OFL license, included alongside it.
