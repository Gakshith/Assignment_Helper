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
- A printer. Note which kind (laser or inkjet) — §6 explains why it matters.
- One stack of identical blank sheets, enough for 10 prints.
- The pen you normally do homework with.
- One judge who has not seen any of this.

---

## 3. Producing the sheets

Both stacks must be the same paper with the same rules, or the judge is sorting on
paper stock instead of handwriting. So the rules get **printed on both stacks**.

**Step 1 — five blank ruled sheets, for you to write on.**

1. Open `index.html`.
2. Leave Surface = **Ruled**, Sheet = **Letter**.
3. **Clear the page text box completely.** The status line should read `0 lines, 0 glyphs`.
4. Click **Print this sheet**. In the print dialog set **Scale: 100 % / Actual size**
   and **Margins: None**. Print 5 copies.

**Step 2 — five machine-written sheets.**

1. Put the sample text back (click **Cycle sample passage** until passage 1 returns,
   or reload the page).
2. Click **Build print kit — 5 sheets @ 300 DPI**. It renders 5 sheets from 5
   different seeds and 5 different passages, then opens the print dialog.
3. Same dialog settings: **Scale 100 %**, **Margins None**. Print once.

Each sheet is 2550 × 3300 px at 300 DPI = exactly 8.5 × 11 in, laid out with
`@page { size: 215.9mm 279.4mm; margin: 0 }`. Verified: the PDF Chrome produces is
5 pages at exactly 612 × 792 pt.

**Step 3 — measure one printed sheet before you go further.** Put a ruler on the
red margin rule: it should be **1.25 in (31.75 mm)** from the left edge, and the
blue rules should be **7.1 mm** apart. If they are not, your printer scaled the page
and the whole run is invalid. Fix the dialog and reprint.

**Step 4 — handwrite the same five passages.**

Copy the five passages from the tool's text box, in order, one per blank sheet, in
your ordinary handwriting at your ordinary speed. Do not neaten up. Do not slow
down. Do not start over because a line went badly — a discarded bad line is exactly
the evidence the experiment needs.

You now have 10 sheets: 5 printed, 5 written.

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

## 6. The confound you must record

The machine sheets are toner or inkjet ink; the handwritten sheets are pen. A judge
may sort correctly on **ink sheen, paper indentation, or edge texture** without ever
looking at a letterform. This experiment cannot eliminate that — printing is how the
real product is used, so it belongs in the test — but it changes what a **≥ 8**
result means.

So: if the score is ≥ 8 **and** the debrief answer is about ink, sheen, gloss, or
"you can feel it," then **the gate has not actually tested letterforms** and
centerlines are not yet justified. Re-run it with the judge looking at
**photographs** of the 10 sheets on a screen instead of the sheets themselves, which
removes the physical cue and leaves only the marks. Use that score for the verdict.

Record which printer you used. An inkjet on absorbent paper is much closer to pen
than a laser is.

---

## 7. Results

Fill this in. Keep it in the repo next to this file.

```
Date:                      ____________________
Judge (initials only):     ____________________
Printer (laser / inkjet):  ____________________
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
