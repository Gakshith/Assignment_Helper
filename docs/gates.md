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
| G1 | Single-block re-render, no reflow | ≤ 40 ms p95 | **NOT MEASURED** — needs the paint engine |
| G2 | Single-block edit that reflows | ≤ 120 ms p95 | **NOT MEASURED** — needs the paint engine |
| G3 | Full-page first render, warm paper | ≤ 400 ms p95 | **NOT MEASURED** — needs paint + paper |
| G3c | — | — | **DELETED.** It was G4 cold (1200) + G3 warm (400) = 1600 exactly: a checksum of two other gates, not an independent one |
| G4 | Paper layer, cold / warm | ≤ 1200 ms / ≤ 5 ms | **NOT MEASURED** — paper engine in flight |
| G5 | Math parse + build + walk | ≤ 3 ms / ≤ 12 ms p99 | **PARTIAL.** The 24-test walk suite runs in 13 ms total including KaTeX parse, tree build and walk for 12 expressions. Not a p99 over 200 samples, so not a pass |
| G6 | Export rasterize, 1 page @200 DPI | ≤ 900 ms | **NOT MEASURED** — needs the browser export half |
| G7 | Raw RGBA POST + decode | ≤ 40 ms | **NOT MEASURED** |
| G8 | Python artifact pipeline, 1 page | ≤ 2.5 s | **PARTIAL.** JPEG encode 41 ms + PDF assembly 10 ms on a synthetic page. Far inside budget, but not a real rendered page |
| G9 | Full export, 20 pages | ≤ 90 s | **NOT MEASURED** |
| G9b | Full export, 1 page | ≤ 6 s | **NOT MEASURED** |
| G10 | PDF size @200 DPI | ≤ 700 KB/page, **warning not gate** | **NOT MEASURED.** A synthetic page of 120k random pixels gave 1481 KB — maximum-entropy noise, far worse than ink. That number is meaningless here and must not be quoted as a G10 result |
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
| I7 | Ink compositing is O(dirty area) | **NOT YET** — paint engine in flight |
| I8 | No pixel literals in the render path | Held by construction; `units.ts` is the only conversion |
| I9 | Handwriting samples never leave the machine, never enter git | ✅ **Enforced at the type level** — `ChatPayload` has no field a profile could travel through, `extra="forbid"` makes it raise, and tests assert both that and the honest half: a rendered page *is* a picture of the user's hand and is sent when they ask about it |
| I10 | Atomic persistence | ✅ Implemented (temp + `os.replace`) |
| I11 | Export never reads the screen | Stated; export re-**paints** geometry at export DPI. It does not re-run layout — doing so would recreate the exact divergence G16 exists to catch |
| I12 | Canvas readback self-test | Implemented in `readback.ts`, not yet wired |
| I13 | Page DOM nodes created once, never replaced | ✅ Verified live — 3 canvases per page, reused across repaints |
| I14 | Counter-based RNG only | ✅ **125 golden vectors match bit-for-bit** across Python and TypeScript |
| I15 | Explicit bypasses, always announced | ✅ Verified live — the dev-build banner names the sha and the dirty tree |
| I16 | No route reachable without the session token | ✅ All four defences tested: no token 403, bad token 403, rebound `Host` 403, cross-site POST 403. Token absent from `repr` and from every response body. Verified live that it is stripped from the URL into `sessionStorage` |
| I17 | CV stack never imported at module scope | ✅ **Enforced** — import-linter, 69 files, 172 dependencies, 2 contracts kept |

## What this table is for

The honest count as of this writing: **1 gate passing with a measured number, 2 partial,
14 unmeasured**, and most of the unmeasured ones are blocked on the same thing — a paint
engine that turns geometry into ink. That is the real critical path, and no amount of
green unit tests substitutes for it.
