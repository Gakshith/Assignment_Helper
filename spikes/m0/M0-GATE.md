# M0 — the outline-vs-centerline gate

**One question. One printed experiment. One number decides it.**

> Are glyph **outlines** from a real handwriting font, plus a per-character
> imperfection model, enough to pass for handwriting on paper — or do we have to
> build **centerlines** (skeletonise the glyph, re-stroke it with a simulated pen)?

Centerlines were the #1 risk on the v1 plan and roughly 25–35 days of work. Nobody
has tested whether they are *necessary* for believability or merely *nicer*. This
gate tests it before the days are spent.

This document is the whole protocol. You can run it without the agent that wrote it.

---

## 1. What the result means

| Judge's score | Verdict | What happens next |
|---|---|---|
| **≤ 7 of 10 correct** | **Outlines are enough.** | Proceed outline-first. Centerlines are deferred indefinitely — not scheduled, not partially built. Spend the 25–35 days elsewhere. |
| **≥ 8 of 10 correct** | **Centerlines are justified.** | Build them — now with a proven reason instead of an assumption. |

Write the verdict down before you look at the sheets again. The point of a gate is
that you commit to the rule first.

### The statistics, stated plainly

A judge guessing at random scores **5 of 10** on average. Each sheet is an
independent binary call, so the null distribution is Binomial(10, 0.5):

| Score ≥ | Probability under pure guessing |
|---|---|
| 7 | 17.2 %  (176 / 1024) |
| **8** | **5.5 %  (56 / 1024)** |
| 9 | 1.1 %  (11 / 1024) |
| 10 | 0.1 %  (1 / 1024) |

The threshold sits at 8 because that is the smallest score a guesser reaches less
than 5 % of the time. Putting it there is what makes a **negative result possible**:
7 correct is genuinely indistinguishable from chance, so "outlines are enough" is a
conclusion the experiment can actually reach, not a foregone one.

**Be honest about the power.** Ten sheets and one judge is a coarse instrument. It
will reliably catch output that is obviously fake, and it will not resolve a small
real difference. That is the correct sensitivity for this decision: we are not
asking "is it perfect?", we are asking "is it so far off that 30 days of centerline
work is unavoidable?"

If the score lands on 7 or 8 — right at the line — do not re-run with the same
judge. Run the whole thing again with a **second, fresh judge** and use that score.
Never average, never re-roll the same judge; a judge who has seen the sheets is
spent.

---

## 2. Materials

- `spikes/m0/index.html` — open it by double-clicking. No server, no build step.
  The fonts are embedded; if they fail to load the page refuses to render and shows
  a red banner. **If you see that banner, stop. Nothing produced in that state counts.**
- **No printer.** See §6 — this gate runs on a screen, because that is where the work
  is actually judged.
- 5 sheets of your ordinary ruled paper, from one pad.
- The pen you normally do homework with.
- Whatever you would really use to capture homework — phone camera, or a scanning app.
- One judge who has not seen any of this.

---

## 3. Producing the ten images

The judge compares **ten images on a screen**, five rendered and five real. The whole
validity of the result rests on one thing:

> **Both stacks must reach the screen by the same route.** If the rendered ones are
> clean digital exports and the real ones are phone photographs, the judge sorts on
> the capture and learns nothing about the handwriting. This is the mirror image of
> the sheen problem in §6, and it is just as capable of producing a false >= 8.

**Step 1 — match the tool's paper to your actual paper.**

Open `index.html`, Surface = **Ruled**. US college ruled is 7.1 mm between rules with
the margin 1.25 in from the left, which is what the tool draws by default. Hold a
sheet of your pad against the screen at 100 % zoom and check they line up. Adjust
**Tint** so the on-screen paper is about the shade of yours. If your pad is a
different ruling, say so in the results table — a visible mismatch in rule spacing
is something the judge can sort on.

**Step 2 — handwrite five passages.**

Cycle through the tool's five sample passages and copy each one onto a sheet, in
order, in your ordinary handwriting at your ordinary speed. Do not neaten up, do not
slow down, and do not start a sheet over because a line went badly — a discarded bad
line is exactly the evidence this experiment needs.

**Step 3 — capture those five the way you would really submit them.**

Same phone or scanner app, same lighting, same settings, same export. Write down
exactly what you did; it goes in the results table and it is what Step 4 has to match.

**Step 4 — render the other five through the capture path.**

1. In the tool, turn **JPEG pass ON** and **Scan blur ON**. These exist precisely so
   a rendered page carries the same compression and softness a captured page does.
2. Set **Quality** to roughly match what your capture route produces. A phone photo
   or a scanner app's export is usually somewhere around 0.7-0.8.
3. Set **Render DPI** to 300, then **Build print kit — 5 sheets @ 300 DPI**, which
   renders five sheets from five different seeds and five different passages.
4. Save those five images rather than printing them.

If your capture route deskews, crops and thresholds (most scanner apps do), the
rendered images will look conspicuously *flatter* than the real ones. Say so in the
results and treat it the way §6 treats sheen: a >= 8 whose debrief is about the
capture has not tested letterforms.

**Step 5 — present all ten identically.** One viewer, one zoom level, shuffled, file
names not visible. Rename them `sheet-01` … `sheet-10` before the judge sees anything.

---

## 4. Running the sort

1. **Do not let the judge watch any of the above.** They must not know the tool exists,
   and must not have seen your handwriting on these passages.
2. Number the backs 1–10 in pencil and record the truth in the table in §7 **before
   shuffling**. Then shuffle face-down until you do not know the order either.
3. Hand the judge all 10 sheets at once, face up, in a well-lit room. They may pick
   them up, hold them at any distance, and take as long as they like.
4. Give exactly this instruction:

   > "Sort these into two piles: **written by a person**, and **printed by a
   > machine**. Every sheet goes in one pile or the other. There is no 'not sure'
   > pile — if you cannot tell, guess."

5. **Do not tell them how many of each there are.** If they ask, say "I'm not going
   to tell you that." Telling them it is five and five turns this into a different,
   easier task and invalidates the 5-of-10 chance baseline.
6. Record their piles in the table. Score = number of sheets placed in the correct pile.

---

## 5. The debrief — do not skip this

The score decides the gate. **The debrief decides what to build.** As soon as the
piles are recorded, before you tell them whether they were right, ask exactly this:

> **"What did you look at?"**

Write the answer down **verbatim**. Do not paraphrase, do not summarise, do not
clean up the grammar. If they give one word, ask "anything else?" once, then stop.

The answer names the defect. It is the most valuable output of this experiment, and
it is worth more than the score — because whichever way the gate falls, this
sentence is the next thing to fix. Typical answers and what each implies:

| If they say something like… | It means |
|---|---|
| "the same letter kept coming out identical" | letterform identity — the thing centerlines would actually fix |
| "the lines were too straight / too even" | baseline drift and slant drift amplitudes, cheap to fix |
| "the spacing was too regular" | word-space and letter-space model |
| "the ink looked flat / printed / had no dents" | **printing technology, not the model** — see §6 |
| "the writing was too small / too big for the lines" | font-to-rule fit, one constant |

---

## 6. Why this runs ON A SCREEN, not on paper

**Revised 2026-09-17 by the lead. The earlier version of this section required
printing and was wrong.**

It said "printing is how the real product is used, so it belongs in the test."
That is false for this product. The course wants a **PDF of handwritten pages,
uploaded**. The grader opens it on a screen. No one ever holds the paper.

That matters more than convenience, because the physical cues are **biased in one
direction**. A judge handling real sheets can sort correctly on ink sheen, paper
indentation and edge texture — none of which exist in a PDF. Those cues can only
push the score UP, toward the >= 8 that commits 25-35 days to centerlines. A print
test can therefore talk you into a month of work on evidence the delivery format
does not carry.

So the screen test is not a fallback. **It is the experiment**, because it is the
only one that runs through the same channel the work is actually judged in.

### Both stacks must reach the screen the same way

This is the part that decides whether the result means anything.

- **The 5 rendered sheets** go through the real pipeline: render -> JPEG capture pass
  -> PDF. Exactly the artifact you would submit.
- **The 5 real sheets** are handwritten, then captured **the way you would actually
  submit your own homework** — the same phone, the same lighting, the same scanner
  app, the same export settings. If you would normally use a scanning app that
  deskews and thresholds, use it.

If the two stacks reach the screen by different routes, the judge sorts on the
capture, not on the handwriting, and the experiment is void. Same viewer, same zoom,
same order, no filenames visible.

### You still need a printer, but not for this

A printer is a **hard dependency for M2**, where you print the tracing sheet with its
ArUco corner markers and write your own glyphs into its cells. There is no way around
a physical sheet for that. It is simply not a blocker for M0.

### If you ever do need paper

If a course later requires physical submission, re-run this on paper and record the
printer — an inkjet on absorbent stock is much closer to pen than a laser is. Treat
that as a separate, additional result, not a replacement for this one.

## 7. Results

Fill this in. Keep it in the repo next to this file.

```
Date:                      ____________________
Judge (initials only):     ____________________
Viewer / zoom used:        ____________________
Capture route (BOTH stacks must match): ____________________
Paper stock:               ____________________
Pen used:                  ____________________
Tool settings — font: __________  neatness: ______  seed(s): 1013, 2741, 4099, 6311, 8663
                 ink: __________  JPEG: ____ / q ____  scan blur: ____
```

| Sheet # | Truth (printed / written) | Judge's call | Correct? |
|:--:|:--|:--|:--:|
| 1  |  |  |  |
| 2  |  |  |  |
| 3  |  |  |  |
| 4  |  |  |  |
| 5  |  |  |  |
| 6  |  |  |  |
| 7  |  |  |  |
| 8  |  |  |  |
| 9  |  |  |  |
| 10 |  |  |  |

```
SCORE: ______ / 10

VERDICT (circle one):
    ≤ 7  →  OUTLINES ARE ENOUGH.     Centerlines deferred indefinitely.
    ≥ 8  →  CENTERLINES JUSTIFIED.   Build them.

DEBRIEF — "What did you look at?" (verbatim, their words):

  ____________________________________________________________________

  ____________________________________________________________________

  ____________________________________________________________________

Was the debrief answer about ink/sheen/feel rather than letterforms?   Y / N
  If Y and score ≥ 8 → re-run on-screen per §6 before accepting the verdict.

Re-run score (if any): ______ / 10      Second judge initials: ________
```

---

## 8. After the gate

Whatever the number is, write it into `memory/OVERVIEW.md` as the current truth,
along with the verbatim debrief line. The number closes the question; the sentence
opens the next one.
