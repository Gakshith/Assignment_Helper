# export strand — what is done and what is not

Written by the lead after the strand was interrupted. Read this before assuming a file here works.

## Done and verified

- **Python, all of it** (`assignment_helper/export/`, 1085 lines). Verified by the lead
  by producing a real PDF: **MediaBox `0 0 612 792` pt = exactly 8.5x11in** at 200 DPI,
  encode 41 ms, PDF assembly 10 ms. `build_stamp()` correctly reports a non-release
  build with its sha, so a dev-rendered PDF is identifiable from the file itself.
- `wire.ts` — the request/response contract and the `x-ah-token` header.
- `readback.ts` — the I12 canvas readback self-test (acceptance row 12).

## NOT done

- `raster.ts` has **no exports**. It is a partial file.
- `index.ts` still returns the **stub** controller, which raises a named problem and
  produces no PDF. That is deliberate: a stub may render nothing, but it may not lie.

## Why it cannot be finished yet, and this is not a scheduling excuse

The controller's job is to re-paint geometry at export DPI in a Worker (invariant I11 —
export never reads the screen). **There is no paint engine yet.** The paint strand was
sequenced after M0 and M0's gate has not been judged. Wiring a controller now would mean
wiring it to the grey-rectangle stub and calling the export path "done" when the thing it
exports is a placeholder.

## Gate numbers — measured and NOT measured

| Gate | Status |
|---|---|
| G8 Python artifact pipeline | encode 41 ms + assemble 10 ms on a synthetic page. Well inside the 2.5 s budget, but not a real page |
| G10 PDF size | **NOT MEASURED.** The lead's synthetic test page was 120k random single pixels — maximum-entropy noise, far worse than ink — and produced 1481 KB. That number is meaningless as a G10 result and must not be quoted as one. G10 needs a really rendered page |
| G6, G7, G9b | **NOT MEASURED.** All need the browser half |
