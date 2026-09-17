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

Handwriting comes from a font built out of your own glyphs: you fill a tracing sheet
once, photograph it, and the pipeline segments and vectorises each cell into several
variants per character. Rendering then applies per-glyph jitter, dual-frequency
baseline drift, slant and ink-weight variation so it never reads as a font.

Everything runs locally. Handwriting samples are close to biometric data and never
leave the machine.

## Status

**Vision stage.** No implementation yet. Nothing here runs.

## Run it

Not yet — there is no code. When there is, it will be a CLI that starts a local server
and opens a browser tab:

```bash
assignment-helper hw7.doc
```

## Scope

This exists for courses that permit AI and require a handwritten format. It reproduces
your own hand from your own samples. It will not gain a feature for imitating anyone
else's handwriting, and it does not automate access to platforms whose terms prohibit
it — Canvas has a documented API and is supported properly; everywhere else is
screenshot in, PDF out, and you do the upload.

## License

Not yet chosen.
