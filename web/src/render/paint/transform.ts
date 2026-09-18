/**
 * The placement -> canvas matrix, and the conservative bound used to cull.
 *
 * ------------------------------------------------------------------------------------
 * THE TRANSFORM CONVENTION IS NOT NEGOTIABLE AND IT IS NOT DECLARED HERE.
 *
 * layout/place.ts states it, and computes every block's bounding box by pushing the
 * glyph's metric box through exactly that chain. The lasso's spatial index, the
 * dirty-rect cull and the export clip all trust those boxes. If this file composes the
 * matrix any other way, the ink and the index disagree and gate G15 starts giving
 * confidently wrong answers — which is worse than giving none.
 *
 * The chain, about the outline's baseline origin, applied to a point in that order:
 *
 *     1. scale   (scaleX, scaleY)
 *     2. slant   horizontal shear; a point h ABOVE the baseline moves right by
 *                h * tan(slantDeg), so positive slantDeg leans the top to the RIGHT
 *     3. rotate  rotDeg about the origin, positive = clockwise on screen (y is down)
 *     4. translate to (xMm, baselineYMm)
 *
 * Nothing else. Every wobble in the page was already decided by layout and is already in
 * these six fields; re-rolling any of it here would double-apply it and break the
 * determinism I1 promises.
 * ------------------------------------------------------------------------------------
 *
 * ON `Math.sin` / `Math.cos` / `Math.tan` HERE, when layout goes to the trouble of a
 * Taylor series to avoid them: layout's output is goldened byte-for-byte across engines,
 * so a last-ulp difference there is a test failure. This file's output is pixels. A 1e-16
 * difference in a matrix coefficient cannot move a subpixel, let alone a pixel, and I1
 * bans `Math.random`, `Date`, `performance.now` and `crypto.getRandomValues` under
 * render/** — not arithmetic.
 */

import type { GlyphPlacement } from '../geometry';
import { mmToPx, type Mm, type RectMm } from '../units';

const DEG_TO_RAD = Math.PI / 180;

/** A canvas 2D matrix: (x, y) -> (a x + c y + e, b x + d y + f). */
export interface Matrix2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/**
 * The em -> device matrix baked into a cached path: scale to device pixels and flip y,
 * because the outline provider's contract is y-UP and the canvas is y-down.
 *
 * Takes the em size already in device pixels rather than (sizeMm, dpi), so the caller can
 * pass the value it also used as the cache key. Deriving it twice is how a cache ends up
 * keyed on one scale and filled at another.
 */
export function emToDeviceMatrix(emPx: number, unitsPerEm: number): Matrix2D {
  const s = emPx / unitsPerEm;
  return { a: s, b: 0, c: 0, d: -s, e: 0, f: 0 };
}

/**
 * The per-instance matrix, for a path that ALREADY carries the em -> device scale and the
 * y flip (see cache.ts). Derived by composing translate . rotate . shear . scale and
 * multiplying out, so the hot loop does eight multiplies and no matrix objects.
 */
export function placementMatrix(p: GlyphPlacement, dpi: number): Matrix2D {
  const rot = p.rotDeg * DEG_TO_RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const tanS = Math.tan(p.slantDeg * DEG_TO_RAD);
  const sx = p.scaleX;
  const sy = p.scaleY;

  return {
    a: cos * sx,
    b: sin * sx,
    c: (-cos * tanS - sin) * sy,
    d: (cos - sin * tanS) * sy,
    e: mmToPx(p.xMm, dpi),
    f: mmToPx(p.baselineYMm, dpi),
  };
}

/**
 * How far a glyph's ink may reach from its baseline origin, as ratios of the em.
 *
 * These are CONSERVATIVE CONSTANTS rather than real metrics, because the frozen
 * `GlyphOutlineProvider` exposes only `outline()` and `unitsPerEm` — paint has no way to
 * ask a hand how tall its letters are. Over-estimating costs a handful of glyphs drawn
 * just outside a dirty rect, where the clip discards them; under-estimating erases ink
 * the user can see. The numbers cover a script face with tall ascenders (Caveat's own
 * ascender is 0.96 em), the variant envelope on top of it, and a left side bearing that
 * reaches behind the pen.
 */
const REACH = {
  up: 1.35,
  down: 0.65,
  left: 0.35,
  /** Beyond the advance. Script faces routinely overhang the next letter. */
  right: 0.85,
} as const;

/**
 * `advanceMm` is the page-space STEP layout took, which already carries the crowd
 * squeeze, while `scaleX` carries the squeeze AND the per-instance width jitter.
 * Multiplying the two would apply the squeeze twice and shrink the bound. The drawn width
 * is `advanceMm * (1 + jitter)` instead, and params.ts caps that jitter at 0.055 before
 * fatigue and 0.085 after, so 1.15 covers it with margin.
 */
const ADVANCE_SLACK = 1.15;

/**
 * A conservative axis-aligned bound, in millimetres, for one placement's ink.
 *
 * Deliberately not the tight box: this is a cull test, and the only property that matters
 * is that it never reports "outside" for a glyph that has ink inside the rectangle.
 *
 * WHERE THE REACH NUMBERS COME FROM. Measured over all 736 cmapped glyphs of the bundled
 * reference hand, over the control-point hull so the figures are a superset of the true
 * curve: up 0.957 em, down 0.299 em, left 0.110 em, and 0.499 em past the advance (a
 * zero-advance combining accent — the honest worst case). Those are then inflated by the
 * variant envelope, which lives INSIDE the cached path where this function cannot see it:
 * scale to 1.09, shear 0.055, rotation 0.05 rad, 0.048 em of vertical offset. That gives
 * 1.09 / 0.37 / 0.18 / 0.59, and the constants above sit above all four with room to
 * spare. Being generous costs a few glyphs drawn just outside a clip, where they are
 * discarded; being tight costs ink the user can see.
 */
export function placementBoundsMm(p: GlyphPlacement, inkPadMm: Mm): RectMm {
  const em = p.sizeMm;
  const x0 = -REACH.left * em * p.scaleX;
  const x1 = p.advanceMm * ADVANCE_SLACK + REACH.right * em * p.scaleX;
  const y0 = -REACH.up * em * p.scaleY;
  const y1 = REACH.down * em * p.scaleY;

  const rot = p.rotDeg * DEG_TO_RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const tanS = Math.tan(p.slantDeg * DEG_TO_RAD);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  // The same chain as placementMatrix, on the four corners. Scale is already folded in.
  for (let i = 0; i < 4; i++) {
    const lx = i === 0 || i === 2 ? x0 : x1;
    const ly = i < 2 ? y0 : y1;
    const sh = lx - ly * tanS;
    const rx = sh * cos - ly * sin;
    const ry = sh * sin + ly * cos;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }

  return {
    xMm: p.xMm + minX - inkPadMm,
    yMm: p.baselineYMm + minY - inkPadMm,
    wMm: maxX - minX + 2 * inkPadMm,
    hMm: maxY - minY + 2 * inkPadMm,
  };
}
