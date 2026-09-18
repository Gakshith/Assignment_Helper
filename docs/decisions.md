# Decisions taken during the build

Cross-cutting calls that are not obvious from any single file. Each says what was
decided, why, and — where it matters — what would make it wrong.

## The paper seed excludes DPI

The brief said seed on `(style, dpi)`. The paper strand seeded on style alone and
flagged the deviation. **Accepted.**

The grain cell is specified in millimetres, so it is already resolution-independent.
Folding DPI into the seed would mean the 300 DPI export showed a *different sheet of
paper* from the 150 DPI preview the user looked at and approved. The cache key still
carries DPI — two rasters, one sheet.

This strengthens rather than weakens "same style ⇒ same paper", and it is the correct
reading of what the invariant is for.

## M0's grain amplitude was arithmetically present and visually invisible

The paper strand measured a flat region of M0's grain at **0.37 luminance levels out of
255** and raised the alpha from 0.085 to 0.85, measuring **2.55** levels — about what a
scan of copier stock shows.

The mechanism checks out analytically, which is why it is recorded rather than merely
believed. The speckle composites in `overlay`, which is the right blend mode: it is
neutral at mid-grey, so it adds no tint and no mean shift. But against near-white paper
overlay compresses to `1 − 2(1−base)(1−blend)`. At paper's luminance (~0.94) that is a
usable range of about 0.10 — roughly a tenth of the nominal amplitude survives.

**What this means for M0's gate:** nothing, and that is worth stating. M0 was verified
for *geometry* — page size, rule pitch, margin position, word integrity, determinism —
and its gate tests letterforms, not paper texture. An invisible grain does not
invalidate a forced-sort result. But any strand inheriting M0's constants should know
they were tuned by eye for shape and never measured for tone.

## The M0 gate runs on a screen, not on paper

The gate doc originally justified printing with "printing is how the real product is
used." It is not: the course wants a PDF of handwritten pages, uploaded, and the grader
opens it on a screen.

Printing also biases the result in one direction. A judge handling physical sheets can
sort on ink sheen, paper indentation and edge texture, **none of which survive into a
PDF** — and those cues can only push the score toward the ≥8 that commits 25–35 days to
building centerlines.

The screen test carries its own mirror-image confound, and it is the controlled one:
both stacks must reach the screen by the same capture route, which is what the tool's
JPEG pass and scan blur exist for. A ≥8 whose debrief is about the capture has not
tested letterforms either.

A printer remains a hard dependency for **M2**, where the ArUco tracing sheet must be
printed and written on. It was never one for M0.

## `watchfiles` was dropped; `scikit-image`'s pin moved forward

Both failed to install on Python 3.14, and they were treated differently on purpose.

`watchfiles` has **no cp314 wheel at any version** and falls back to a Rust build. Per
the fallback doctrine — every fallback must reduce scope — the dependency was dropped
and file watching became a stdlib mtime poll.

`scikit-image` 0.25 builds from source and fails, but **0.26.0 ships cp314 wheels**. A
real wheel exists, so the pin moved. Moving a pin to a version that genuinely exists is
not the same act as keeping a dependency alive by pinning the interpreter down to it.

## Licensed handwriting fonts have no Greek, and physics is made of Greek

Measured across all three OFL hands shipped with this project:

| Font | codepoints | Greek block | has α τ θ |
|---|---|---|---|
| Caveat | 753 | 1 | no |
| Reenie Beanie | 320 | 4 | no |
| Shadows Into Light | 349 | 0 | no |

**This contradicts a claim in the plan.** §C.2 listed "the reference-hand authoring
problem" among the things outline-first *deletes*, on the grounds that it "makes any
permissively-licensed handwriting font a valid shipped reference hand, immediately,
free." That is true for prose and **false for maths**, which is the milestone that
needs it most. It only surfaced by rendering a real physics assignment, where the very
first expression wanted `\tau`.

The behaviour is correct — the block is badged `glyph.missing` naming the character,
and the rest of the page renders (acceptance row 5) — but a physics page with the
Greek silently absent from the *ink* and present only in a badge is not a page anyone
would hand in.

**Two consequences, both binding:**

1. **The M2 tracing sheet must include Greek and the common maths operators.** It was
   specified as "~90 cells" of what is implicitly the Latin alphabet. A student's own
   hand fixes this completely — they write their own α and τ — but only if the sheet
   asks for them. This is now a requirement on the glyph-extract strand, not a nicety.
2. **The reference hand needs a documented coverage limit.** Until M2, the shipped
   hand cannot render Greek at all, and the README should say so rather than letting a
   user discover it on the assignment they are about to submit.

Not chosen, and why: a Greek fallback font would mix two hands mid-expression, which
looks worse than an honest badge and undermines the one thing the product sells.
