# Gate scorecard

Seventeen performance gates and seventeen runtime invariants were specified before any
code existed. This file records which are **measured**, which are **enforced**, and
which are neither — with the number where there is one.

**The rule for this file: a gate is MEASURED only if a command in this repo produced
the number.** Anything else says NOT MEASURED, including gates whose implementation
looks obviously fast. An estimate presented as a measurement is worse than a blank.

Last updated 2026-09-17.

## Performance gates

| # | Gate | Budget | Status |
|---|---|---|---|
| G1 | Single-block re-render, no reflow | ≤ 40 ms p95 | ✅ **PASS — 18.3 ms p95** over 60 samples on a 13-page, 445-block document |
| G2 | Single-block edit that reflows | ≤ 120 ms p95 | **NOT MEASURED.** Needs an edit that reflows; `tests/perf/gates.mjs` says so rather than reporting G1's number twice |
| G3 | Full-page first render, warm paper | ≤ 400 ms p95 | ✅ **PASS — 38.4 ms p95**, same document, 30 samples |
| G3c | — | — | **DELETED.** It was G4 cold (1200) + G3 warm (400) = 1600 exactly: a checksum of two other gates, not an independent one |
| G4 | Paper layer, cold / warm | ≤ 1200 ms / ≤ 5 ms | **NOT MEASURED** — paper engine in flight |
| G5 | Math parse + build + walk | ≤ 3 ms / ≤ 12 ms p99 | **PARTIAL.** The 25-test walk suite runs in ~13 ms total including parse, build and walk for 12 expressions. Not a p99 over 200 samples, so not a pass |
| G6 | Export rasterize, 1 page @200 DPI | ≤ 900 ms | **PARTIAL.** Whole browser→PDF round trip is 1.3 s, of which rasterize is a fraction. Not isolated, so not a pass |
| G7 | Raw RGBA POST + decode | ≤ 40 ms | **NOT MEASURED** |
| G8 | Python artifact pipeline, 1 page | ≤ 2.5 s | **PARTIAL.** JPEG encode 41 ms + PDF assembly 10 ms on a synthetic page. Far inside budget, but not a real rendered page |
| G9 | Full export, 20 pages | ≤ 90 s | **NOT MEASURED** |
| G9b | Full export, 1 page | ≤ 6 s | ✅ **PASS — 1.3 s**, browser click to PDF on disk, measured in a real browser against the real server |
| G10 | PDF size @200 DPI | ≤ 700 KB/page, **warning not gate** | ✅ **PASS — 356 KB/page** on a really rendered page with procedural grain. (An earlier synthetic figure of 1481 KB was 120k random pixels — maximum-entropy noise, not ink — and was never a G10 result) |
| G11 | Peak memory, 20-page export | ≤ 1.2 GB / ≤ 2.0 GB | **NOT MEASURED** |
| G12 | Glyph extraction, one sheet | ≤ 60 s, rectify+segment ≤ 8 s | **NOT MEASURED** — M2 in flight |
| G13a | Warm start → first page | ≤ 2.0 s | **NOT MEASURED** |
| G13b | First launch after install | ≤ 5.0 s | **ENFORCED, not timed.** I17's import-linter contract proves `cv2`/`skimage`/`numpy` are unreachable from the serve path, which is the mechanism the gate depends on |
| G14 | Chat: send → first anything | ≤ 2.5 s p95 | **NOT MEASURED** — needs a live API key |
| G15 | Lasso hit-test, 20-page doc | ≤ 2 ms per pointermove | ✅ **PASS — 0.09 µs** per hit-test, 9.6 µs per full-page rect-select, over a real 20-page 800-block document. 20,000× headroom. The plan predicted ~0.05 ms for a spatial index and warned that anything near 16 ms meant a linear scan was hiding behind the gate |
| G16 | Preview↔export parity | SSIM ≥ 0.97, **ink mask only** | **NOT MEASURED** — needs both render paths |
| G17 | Re-render determinism | SSIM ≥ 0.999 | **NOT MEASURED** at the pixel level. Geometry determinism (I1) *is* tested |

## Invariants

| # | Invariant | Status |
|---|---|---|
| I1 | Geometry determinism | ✅ Tested (layout deep-equality) **and** enforced — `integrate.sh` greps `render/**` for `Math.random`, `Date`, `performance.now`, `crypto.getRandomValues` |
| I2 | Pixel determinism is SSIM, not bytes | Stated. The cross-browser clause was **deleted for v1** — nothing runs a second browser, and an invariant with no enforcement is a wish |
| I3 | Block isolation | ✅ Tested — editing one block leaves earlier blocks byte-identical |
| I4 | One source of truth | ✅ Tested and verified live — a stale `parent_version` returns 409 naming **both** versions, not a bare 500 |
| I5 | No silent failure | ✅ Enforced in `integrate.sh`. The grep was **strengthened** after ruff's SIM105 found a swallowed exception it missed: it matched only bare `except:`, not the typed `except X:\n    pass` |
| I6 | Every timeout has a named, visible fallback | Implemented in the LLM client (120 s request, 45 s stall, bounded backoff shown as a countdown) and the WS reconnect budget |
| I7 | Ink compositing is O(dirty area) | Implemented — paint clips to the dirty rect expanded by the ink kernel and skips glyphs outside it. Not yet measured under G1 |
| I8 | No pixel literals in the render path | Held by construction; `units.ts` is the only conversion |
| I9 | Handwriting samples never leave the machine, never enter git | ✅ **Enforced at the type level** — `ChatPayload` has no field a profile could travel through, `extra="forbid"` makes it raise, and tests assert both that and the honest half: a rendered page *is* a picture of the user's hand and is sent when they ask about it |
| I10 | Atomic persistence | ✅ Implemented (temp + `os.replace`) |
| I11 | Export never reads the screen | ✅ **Built and exercised.** `ExportSources` hands the controller GEOMETRY and the paint engines, never a bitmap, so it cannot upscale the screen even by mistake. Verified by producing a PDF |
| I12 | Canvas readback self-test | ✅ Wired — runs once before the first export; a failure disables export and leaves preview working |
| I13 | Page DOM nodes created once, never replaced | ✅ Verified live — 3 canvases per page, reused across repaints |
| I14 | Counter-based RNG only | ✅ **125 golden vectors match bit-for-bit** across Python and TypeScript |
| I15 | Explicit bypasses, always announced | ✅ Verified live — the dev-build banner names the sha and the dirty tree |
| I16 | No route reachable without the session token | ✅ All four defences tested: no token 403, bad token 403, rebound `Host` 403, cross-site POST 403. Token absent from `repr` and from every response body. Verified live that it is stripped from the URL into `sessionStorage` |
| I17 | CV stack never imported at module scope | ✅ **Enforced** — import-linter, 69 files, 172 dependencies, 2 contracts kept |

## How G1 was nearly reported as passing while being broken

Worth recording, because the failure was invisible in every other signal.

The first harness bracketed an invalidation with two awaited animation frames and
reported wall time. At 60 Hz that is ~33 ms of vsync, so it measured the display
refresh: it would have printed ~35 ms against a 40 ms budget and called it a pass while
saying nothing about the code. Fixed by reading the scheduler's own `lastFlushMs` —
which exists precisely because invariant I1 bans `performance.now()` under `render/**`,
so the instrumentation had to live in `kernel.ts` anyway.

With honest timing, **G1 and G3 came out equal**. A single-block repaint cannot
legitimately cost the same as a full page, and that equality was the only symptom of
two real defects:

1. The kernel passed **no dirty rect** to `paintInk`, so every edit repainted the whole
   page's ink. Invariant I7 says cost is O(dirty area); the paint engine supported it
   and the kernel never asked.
2. The layout engine emitted `docVersion: -1` — it cannot know a version, because
   `layout(doc, style, metrics)` receives a Document and a version belongs to a
   Snapshot. So the kernel's cache check was **always** true and **every repaint
   re-laid out the entire document**. On this 13-page document that is 445 blocks
   re-laid out per keystroke.

Both passed every unit test, and on a one-page document both still measured inside
budget. They separate only on a document big enough to matter — which is exactly the
document the gate was written for.

## What this table is for

Honest count as of 2026-09-18: **5 gates passing with measured numbers** (G1, G3, G9b,
G10, G15), **3 partial** (G5, G6, G8), **9 unmeasured**.

What the remaining unmeasured ones need is no longer a missing subsystem — the pipeline
is closed end to end — it is a **harness**: G1/G2/G3 want p95 over 200 instrumented
repaints, G4 wants cold/warm paper timings in the real app, G11 wants a memory sample
during a 20-page export, G16/G17 want SSIM between two renders. Those are an afternoon
of measurement, not an afternoon of building, and the distinction matters when planning.

Two gates cannot be measured here at all and should stop being listed as pending work:
**G13a/G13b** need a clean install, and **G12** needs a printed tracing sheet and a
phone. **G14** needs a live API key.
