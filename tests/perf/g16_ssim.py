"""G16 — SSIM between the ink painted at 150 DPI and at 300 DPI downsampled to 150.

Run `tests/perf/g16.mjs` first; it writes the two PNGs this reads.

    ≥ 0.97 passes, < 0.95 is a hard fail.

**The downsample kernel is stated, because it alone moves SSIM by 0.02–0.05.** Lanczos
is used: it is what a print pipeline would do, and picking the kernel that flatters the
result is how a parity gate becomes decoration.

**Ink mask only.** Procedural paper grain is generated per device pixel, so it is
resolution-dependent by construction and comparing it makes this gate unpassable for a
reason that has nothing to do with parity. What G16 asks is whether the same geometry,
painted at two resolutions, puts ink in the same PLACE.
"""

from __future__ import annotations

import sys
from pathlib import Path

TMP = Path("/Users/gojuruakshith/.claude/jobs/7f9afd6b/tmp")
PASS = 0.97
HARD_FAIL = 0.95
KERNEL = "LANCZOS"


def main() -> int:
    import numpy as np
    from PIL import Image
    from skimage.metrics import structural_similarity

    lo_path = TMP / "g16-ink-150.png"
    hi_path = TMP / "g16-ink-300.png"
    for p in (lo_path, hi_path):
        if not p.exists():
            print(f"missing {p}. Run: node tests/perf/g16.mjs \"<url>\" first.")
            return 2

    lo = Image.open(lo_path)
    hi = Image.open(hi_path)

    # The ink layer is transparent where there is no ink, so the ALPHA channel is the
    # mask directly — no thresholding of a colour, and no dependence on ink colour.
    lo_mask = np.array(lo.getchannel("A"), dtype=np.float64)
    hi_img = hi.getchannel("A").resize(lo.size, getattr(Image.Resampling, KERNEL))
    hi_mask = np.array(hi_img, dtype=np.float64)

    score = float(structural_similarity(lo_mask, hi_mask, data_range=255.0))

    lo_ink = float((lo_mask > 8).mean())
    hi_ink = float((hi_mask > 8).mean())

    print(f"ink @150: {lo.size[0]}x{lo.size[1]}, {lo_ink * 100:.2f}% covered")
    print(f"ink @300 -> 150 ({KERNEL}): {hi_ink * 100:.2f}% covered")
    print(f"SSIM = {score:.4f}   pass >= {PASS}, hard fail < {HARD_FAIL}")

    if lo_ink < 0.001:
        print("REFUSING TO PASS: there is almost no ink on the page, so SSIM is")
        print("comparing two nearly-empty images and would score ~1.0 either way.")
        return 2

    if score < HARD_FAIL:
        print("HARD FAIL")
        return 1
    verdict = 0 if score >= PASS else 1
    print("PASS" if score >= PASS else "OVER BUDGET (above the hard-fail line)")

    # ------------------------------------------------------------------ G17
    repeat_path = TMP / "g17-ink-repeat.png"
    if repeat_path.exists():
        repeat = np.array(Image.open(repeat_path).getchannel("A"), dtype=np.float64)
        g17 = float(structural_similarity(lo_mask, repeat, data_range=255.0))
        print()
        print(f"G17 re-render determinism, same browser: SSIM = {g17:.6f}")
        print("    pass >= 0.999, hard fail < 0.995")
        if g17 < 0.995:
            print("    HARD FAIL")
            verdict = 1
        elif g17 < 0.999:
            print("    OVER BUDGET")
            verdict = 1
        else:
            print("    PASS")
    else:
        print()
        print("G17 NOT MEASURED: g17-ink-repeat.png is missing.")

    return verdict


if __name__ == "__main__":
    raise SystemExit(main())
