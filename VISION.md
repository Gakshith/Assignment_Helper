# Assignment_Helper — Vision

*Drafted 2026-09-17. Vision, not a plan. Nothing here is a commitment to build order.*

---

## The thesis

**A page of handwriting is a document format that software forgot how to write.**

We can generate text, images, video, music, code and speech. We cannot generate the
one artifact that a hundred million students are required to produce every week: a
page that looks like a person sat down with a pen and worked something out.

Assignment_Helper is that missing renderer. Content goes in — solved problems, notes,
derivations, prose, anything. A page comes out that reads as genuinely handwritten,
in your hand, on the paper you chose, and it stays editable the whole way.

---

## The problem, precisely

A course permits AI assistance. The same course requires the work be submitted as a
PDF of handwritten pages. These two rules are not in conflict — one governs *how you
may think*, the other governs *what format you submit in* — but no tool sits in the
gap between them. So the student does the work with AI and then spends forty minutes
transcribing it onto paper by hand, purely to satisfy a file format.

That transcription is the waste. It teaches nothing, it proves nothing, and it is the
only step in the pipeline a machine cannot currently do.

---

## What it actually is

**A handwritten-page engine.** Subject-agnostic.

The assignment-solving half is generic agent work — give it a link and a task, it does
the task. That part is replaceable and not where the value is. Physics is simply the
first subject through the door; the same engine serves a chemistry derivation, a math
proof, a set of lecture notes, a language exercise, a lab writeup.

What is *not* replaceable is the render: glyphs that are yours, math that was written
rather than typeset, diagrams that were drawn rather than plotted, paper that was
photographed rather than exported.

> **Everything else in this document is in service of the render.**

---

## The architectural idea that makes it work

**The image is a view. The document is the truth.**

Most "text to handwriting" tools produce pixels and stop. Once it is pixels, it is
dead — you cannot fix a typo, you cannot ask a question about line 4, you cannot
re-render step 3 in a different pen without redoing the page.

So the source of truth is never the image. It is a structured document:

```
Document
└── Page[]
    └── Block[]
        ├── Prose      "Since friction is negligible, energy is conserved."
        ├── Math       LaTeX:  v_y = v_0 \sin\theta
        ├── Diagram    a declarative figure spec (forces, axes, labels)
        ├── Boxed      a final answer, with its units
        └── Spacer     blank lines, margin notes, a doodle
```

The renderer is a pure function of that document plus a style:

```
render(Document, Style, seed) -> Page image
```

Deterministic given a seed, so the same document renders the same page twice — and a
new seed gives a *differently imperfect* page, the way writing it out twice would.

Everything the user wants follows for free from this one decision:

- **Editing** — change the block, re-render. Not pixel surgery.
- **Chatting with the AI about what's on the page** — the AI reads the document, not
  an OCR guess of its own output. It knows line 4 is `Math` and what LaTeX it holds.
- **Restyle** — same document, different paper, different pen, re-render.
- **Re-roll one equation** — new seed for one block, page unchanged around it.
- **Export** — the PDF is a render target, not a separate pipeline.

This is the single decision the whole project rests on. Get it wrong and you have
another text-to-handwriting toy.

---

## The five subsystems, honestly ranked

| # | Subsystem | Standard | Why |
|---|---|---|---|
| 3 | **Handwriting engine** | **Excellent** | The product. Nobody has built this well. |
| 4 | Canvas editor + AI chat | Good | What makes the render usable instead of a lottery. |
| 2 | Solver | Adequate | A model does this. Not our contribution. |
| 1 | Ingest | Fallback-first | See below — the automatic path barely exists. |
| 5 | Submit | Fallback-first | See below — same. |

Building all five to the same standard is how this dies at 40% complete on every
front. One is excellent; the rest earn their place by not getting in the way.

---

## The handwriting engine

### Why a font, and not a diffusion model

The research models are real and they are good. One-DM generates convincing
handwriting from a **single** reference word. DiffusionPen needs five. Both are MIT
licensed with public weights and both run on Apple Silicon.

They are also the wrong tool here, for three reasons that all point the same way:

1. **They generate word images.** Not lines, not paragraphs, not pages. Layout is
   still yours to build regardless of which model you pick.
2. **They cannot do math.** Every one of them is trained on IAM — English prose in the
   Latin alphabet. A subscript, an integral sign, a vector arrow is out of
   distribution. Physics is mostly math.
3. **They are not controllable.** The user wants to fix *this character*. A diffusion
   model does not offer that handle.

A font does. It is deterministic, instant, CPU-only, offline forever, and every glyph
is individually addressable.

### From your hand to a typeface

```
  glyph sheet            photograph           segment + vectorize
  ┌───┬───┬───┐                                    ╱
  │ a │ a │ a │   ─────▶   phone photo   ─────▶   ╱  4 variants
  ├───┼───┼───┤            corner markers        ╱   per character
  │ b │ b │ b │            deskew, threshold    ╱
  └───┴───┴───┘                                ▼
                                         personal font
                                    (fontTools, built locally)
```

You write each character a few times on a printed sheet — letters, digits, and the
symbols that matter: `∫ ∑ √ θ π Δ ω μ ± ∞ → ⟂ ∂ ≈ ≤`. One photograph. The sheet's
corner markers give the homography to deskew it; each cell is segmented, thresholded,
traced to a contour and emitted as a glyph.

Multiple variants per character is the single highest-leverage detail in the entire
engine. **Real handwriting never draws the same letter twice.** A font that does is
identifiable as a font from across the room, no matter how good the letterforms are.

Critically, this runs **locally**. Samples of your handwriting are close to biometric
data and they never leave the machine. That rules out uploading to a third-party font
service, which is otherwise the easy path.

### The imperfection stack

Good letterforms are maybe a third of it. The rest is what a font never does:

- **Variant selection** — rotate through the glyph variants, never the same twice in
  a row, weighted by what precedes it.
- **Per-glyph jitter** — rotation ±2°, vertical offset, scale ±5%. Independent per
  instance.
- **Dual-frequency baseline drift** — this is the detail that sells it. Not one
  wobble but two: fast per-character noise *plus* a slow sine wander across the line,
  the hand drifting off the ruling and correcting itself. Every source that has
  looked at this closely converges on the two-frequency model.
- **Slant drift** — the angle wanders across a line and between lines. It is not an
  italic setting.
- **Ink weight** — stroke thickness tracks simulated pen pressure; heavier into a
  stroke, lighter on the exit, pooling where the pen paused.
- **Spacing entropy** — word gaps vary; lines crowd toward the right margin as the
  hand runs out of room, the way real writing does.
- **Fatigue** — page 3 is measurably worse than page 1. Amplitude on every parameter
  above creeps upward through the document. Nobody writes their fifth page as neatly
  as their first.

### Math — the hard part, stated plainly

**This is the highest technical risk in the project, and it has no off-the-shelf
solution.**

The generative literature is thin and unusable: DiffMath, SFRD and the GAN-based
approaches are real papers targeting OCR *training-data augmentation*, with no public
weights and a vocabulary limited to the CROHME symbol set. Google's MathWriting
dataset (230k human-written samples) is the best data available and is licensed
CC BY-NC-SA — non-commercial — and nobody has shipped a usable generator from it.

So math is **laid out, not generated**. A layout engine walks the LaTeX tree and
places glyphs from the personal font:

```
        LaTeX:  \frac{v_0^2 \sin 2\theta}{g}

        layout tree              rendered by hand
        ─────────────            ────────────────
        frac                          v₀² sin2θ
        ├── num: v_0^2 sin 2θ        ───────────   ← bar drawn as a
        └── den: g                        g          pen stroke, not
                                                     a rectangle
```

Every structural element is a *drawn* element: the fraction bar is a slightly
non-straight pen stroke, the radical is a hand-drawn tick with a wobbling vinculum,
large delimiters stretch by redrawing rather than scaling, the integral sign is your
own glyph elongated along its spine.

AMS Euler is the reference point for what this should feel like — Zapf designed it to
capture "mathematics as it might be written by a mathematician with excellent
handwriting." We are building the same intent, but from *your* hand rather than Zapf's.

Honest risk: constructing correct math layout (spacing classes, delimiter stretching,
sub/superscript positioning, nested fractions) is real engineering, and it is the
thing most likely to consume the schedule. It gets prototyped before anything else is
trusted.

### Diagrams

Free-body diagrams, sketched axes, circuits, ray diagrams. No existing system
generates these — it is a second renderer, smaller than the math one.

A declarative spec compiles to primitives (line, arrow, arc, label, hatch), and each
primitive is drawn with the same jitter machinery as the glyphs: a "straight" line is
a slight curve, a right angle is 88°, a circle does not quite close, an arrowhead is
two strokes that overshoot.

```
   spec                        drawn
   ────                        ─────
   incline(θ=30)                      ↑ N
   block(on=incline)                  ┊
   force(N, normal)              ╱▫╲──┊──→
   force(mg, down)              ╱  ┊ ╲
   force(f, up_slope)          ╱   ↓mg╲
   label("θ", at=base)        ╱ θ      ╲
                             ╱__________╲
```

### Paper and ink

The last 20% of believability is not the writing, it is everything around it.

Paper is a first-class style object, not a background image: **ruled** (with the
margin line, in the right red), **plain**, **grid**, **engineering pad**, **rough
newsprint**, plus color and age. On top of that, a compositing pass with no ML in it:

- ink bleeding into simulated paper fibre, feathering at stroke edges
- paper grain and a faint surface shading pass
- the page not quite square to the frame; a slight perspective warp
- a soft shadow along one edge, as if photographed rather than scanned
- **and a final JPEG re-compression** — this one matters more than it sounds. A
  pristine PNG reads as *generated* instantly. Real submitted work has been through
  a phone camera and a compressor.

The `scan-simulator` project (MIT) has 23 physically-motivated transforms along
exactly these lines and is worth mining rather than reinventing.

---

## Ingest and submit: what is actually possible

Research settled this, and the answer is less than hoped. Stating it here so no one
designs against a fantasy later.

**Reading the assignment.** Expert TA has no public API and no developer program. Its
entire integration surface is LTI 1.1/1.3 — an SSO-and-grade-passback protocol that
by design never hands assignment *content* to a third party. There is no link you can
give a script that returns your questions. Canvas is the exception: a documented REST
API, a student's own personal access token, real assignment reads.

**Submitting the PDF.** Canvas supports it properly and sanctioned:

```
POST /api/v1/courses/:c/assignments/:a/submissions/:user/files   → upload
POST /api/v1/courses/:c/assignments/:a/submissions               → submit
     submission[submission_type]=online_upload
```
*"You must be actively enrolled as a student in the course/section to do this."*

Gradescope has no public API — their own documentation lists one as an unshipped
roadmap item — and their Terms of Use prohibit *"copying, distributing, or disclosing
any part of the Service in any medium, including without limitation by any automated
or non-automated 'scraping'."* That clause is unqualified.

**So the design is tiered, and the bottom tier is the one that always works:**

| Tier | Mechanism | Where |
|---|---|---|
| 1 | Official API, your own token | Canvas, both directions |
| 2 | *Not built.* Browser automation | Documented as a non-goal, see below |
| 3 | **Screenshot in, PDF out** | Everything else, forever |

Tier 3 is not a consolation prize — it is the primary path and it is deliberately
excellent. Screenshot any assignment on any platform, a vision model transcribes it
into problems. Finished PDF lands in a folder and opens. You upload it. Ten seconds,
zero dependencies, nothing to break when a vendor ships a redesign, no terms
violated anywhere.

---

## Shape of the thing

Following the pattern of `lavish-axi`, which is where this idea started: **a CLI that
starts a local server and opens a browser tab.** No Electron, no Tauri, no account, no
cloud.

```
$ assignment-helper hw7.doc

  ▸ local server on :7420
  ▸ opening browser
  ▸ session keyed to ./hw7.doc
```

Sessions are keyed to the file path on disk, so re-running on the same document
resumes exactly where you were. A file watcher pushes live re-renders over WebSocket
while preserving your scroll position and open edits — that state-preserving reload
is the part of Lavish most worth studying at the source level.

One deliberate divergence: Lavish contains no model access at all; it is a review
surface that an external agent drives. Assignment_Helper embeds the model call
directly, bring-your-own-key. That piece has no template and is ours to design.

---

## What this is not

- **Not a cheating tool.** It exists for courses that permit AI and require a
  handwritten format. That is the entire premise, and if a course forbids AI this
  software has no legitimate use in it.
- **Not a forgery tool.** It reproduces *your own* hand, from *your own* samples,
  on your own machine. It will not have a "upload someone else's handwriting" feature.
- **Not a scraper.** Where a platform's terms prohibit automated access, we do not
  automate it and we do not ship an unofficial client that quietly does.
- **Not a service.** No account, no server, no telemetry, no handwriting samples
  leaving the machine. Ever.
- **Not a physics tool.** Physics is the first subject, not the category.

---

## Open questions

Real ones, unresolved as of drafting:

1. **Can hand-drawn math layout reach believability at all?** Everything rests on
   this and it has no precedent to copy. Prototype it before trusting the rest.
2. **How much sample does a good font need?** 4 variants per glyph is a guess. The
   honest answer comes from looking at rendered pages.
3. **Where does the tracing sheet stop?** Full Greek? Every operator? Or a base set
   plus graceful degradation to a fallback hand for rare symbols?
4. **Does the fatigue model help or hurt?** Deliberately degrading later pages is
   either the detail that sells it or a gimmick that makes pages worse.
5. **Is Tier-2 ever worth revisiting?** Current answer: no. Recorded so the answer
   is a decision rather than an omission.

---

## The measure of success

Not a feature list. One test:

> **Print a rendered page. Put it in a stack with pages you actually wrote. Hand the
> stack to someone who knows your handwriting. If they cannot sort it, the engine
> works.**

Everything in this document is either in service of passing that test, or it is
decoration.
