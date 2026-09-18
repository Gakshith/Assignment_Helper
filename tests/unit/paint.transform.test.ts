/**
 * The transform convention, tested against the PROSE in layout/place.ts rather than
 * against paint's own implementation.
 *
 * This is the one seam in the strand with no compiler on it: layout computes bounding
 * boxes by pushing a metric box through a transform chain it describes in a comment, and
 * paint draws ink by building a matrix it describes in a comment. Nothing makes those two
 * comments agree. So the chain is spelled out here, literally, once, and both sides are
 * measured against it.
 */

import { describe, expect, it } from 'vitest';
import type { GlyphPlacement } from '@/render/geometry';
import { mmToPx } from '@/render/units';
import { emToDeviceMatrix, placementBoundsMm, placementMatrix } from '@/render/paint/index';

const DPI = 150;

function placement(over: Partial<GlyphPlacement> = {}): GlyphPlacement {
  return {
    ch: 'e',
    xMm: 30,
    baselineYMm: 40,
    sizeMm: 4.2,
    rotDeg: 0,
    slantDeg: 0,
    scaleX: 1,
    scaleY: 1,
    variant: 0,
    advanceMm: 2.1,
    ...over,
  };
}

/**
 * The chain exactly as layout/place.ts documents it, in screen space (y down):
 *   1. scale  2. shear (a point h ABOVE the baseline moves right by h*tan) 3. rotate
 *      (positive = clockwise)  4. translate
 * Input is a point in unscaled glyph space, millimetres relative to the baseline origin.
 */
function reference(p: GlyphPlacement, x: number, y: number): { x: number; y: number } {
  const sx = x * p.scaleX;
  const sy = y * p.scaleY;
  const tan = Math.tan((p.slantDeg * Math.PI) / 180);
  const shear = sx - sy * tan;
  const cos = Math.cos((p.rotDeg * Math.PI) / 180);
  const sin = Math.sin((p.rotDeg * Math.PI) / 180);
  return {
    x: p.xMm + shear * cos - sy * sin,
    y: p.baselineYMm + shear * sin + sy * cos,
  };
}

/** Run a point through paint's real path: em -> device bake, then the instance matrix. */
function painted(
  p: GlyphPlacement,
  unitsPerEm: number,
  emX: number,
  emY: number,
): { x: number; y: number } {
  const bake = emToDeviceMatrix(mmToPx(p.sizeMm, DPI), unitsPerEm);
  // The cached path is the outline under `bake`. Note emY is y-UP, per the contract.
  const bx = bake.a * emX + bake.c * emY + bake.e;
  const by = bake.b * emX + bake.d * emY + bake.f;
  const m = placementMatrix(p, DPI);
  return { x: m.a * bx + m.c * by + m.e, y: m.b * bx + m.d * by + m.f };
}

describe('placementMatrix agrees with the chain layout documents', () => {
  const upem = 1000;
  // A point half an em above the baseline and a third of an em to the right, expressed
  // both ways: y-up font units for paint, millimetres-down for the reference.
  const emX = upem / 3;
  const emY = upem / 2;

  const cases: readonly GlyphPlacement[] = [
    placement(),
    placement({ rotDeg: 2.4 }),
    placement({ rotDeg: -3.1 }),
    placement({ slantDeg: -12 }),
    placement({ slantDeg: 17.5 }),
    placement({ scaleX: 1.07, scaleY: 0.93 }),
    placement({ rotDeg: -2.2, slantDeg: -8.4, scaleX: 0.95, scaleY: 1.06, xMm: 112.5, baselineYMm: 201.25 }),
  ];

  for (const p of cases) {
    it(`rot=${p.rotDeg} slant=${p.slantDeg} sx=${p.scaleX} sy=${p.scaleY}`, () => {
      const mmX = (emX / upem) * p.sizeMm;
      const mmY = -(emY / upem) * p.sizeMm; // y-up em -> y-down millimetres
      const want = reference(p, mmX, mmY);
      const got = painted(p, upem, emX, emY);
      expect(got.x).toBeCloseTo(mmToPx(want.x, DPI), 9);
      expect(got.y).toBeCloseTo(mmToPx(want.y, DPI), 9);
    });
  }

  it('leans the top of the letter RIGHT for a positive slant', () => {
    const p = placement({ slantDeg: 20 });
    const top = painted(p, upem, 0, upem); // one em above the baseline
    const origin = painted(p, upem, 0, 0);
    expect(top.x).toBeGreaterThan(origin.x);
  });

  it('puts the ascender ABOVE the baseline on the canvas', () => {
    const p = placement();
    const top = painted(p, upem, 0, upem);
    const origin = painted(p, upem, 0, 0);
    // Canvas y grows downwards, so "above" is a smaller y.
    expect(top.y).toBeLessThan(origin.y);
  });
});

describe('placementBoundsMm is conservative', () => {
  /**
   * The ink envelope of the bundled reference hand, in ems, measured over all 736 cmapped
   * glyphs on the control-point hull. `right` is how far past the advance the ink reaches
   * (a zero-advance combining accent; the honest worst case).
   */
  const INK = { up: 0.957, down: -0.299, left: -0.11, right: 0.499 } as const;

  /**
   * The variant affine, which lives INSIDE the cached path where placementBoundsMm cannot
   * see it. The bound has to absorb it, so the test pushes the envelope through every
   * sign combination of the variant's extremes before checking containment.
   */
  const V = { scale: 1.09, shear: 0.055, rot: 0.05, dy: 0.2 / 4.2 } as const;

  const cases: readonly GlyphPlacement[] = [
    placement(),
    placement({ rotDeg: 4.9, slantDeg: 19, scaleX: 1.12, scaleY: 1.14, advanceMm: 3.4 }),
    placement({ rotDeg: -4.9, slantDeg: -19, scaleX: 0.88, scaleY: 0.86 }),
    placement({ advanceMm: 0.01 }), // a combining mark: almost all overhang
  ];

  /** Every extreme corner of the variant-perturbed em box, in ems, y-up. */
  function envelopeCorners(advanceEm: number): { x: number; y: number }[] {
    const out: { x: number; y: number }[] = [];
    for (const ex of [INK.left, advanceEm + INK.right]) {
      for (const ey of [INK.up, INK.down]) {
        for (const rot of [V.rot, -V.rot]) {
          for (const shear of [V.shear, -V.shear]) {
            for (const dy of [V.dy, -V.dy]) {
              const sx = ex * V.scale;
              const sy = ey * V.scale;
              const hx = sx + shear * sy;
              const cos = Math.cos(rot);
              const sin = Math.sin(rot);
              out.push({ x: hx * cos - sy * sin, y: hx * sin + sy * cos + dy });
            }
          }
        }
      }
    }
    return out;
  }

  for (const p of cases) {
    it(`contains the real ink envelope for rot=${p.rotDeg} slant=${p.slantDeg} adv=${p.advanceMm}`, () => {
      const b = placementBoundsMm(p, 0);
      // The advance in ems is what layout's own metrics would have produced.
      const advanceEm = p.advanceMm / p.sizeMm;
      for (const c of envelopeCorners(advanceEm)) {
        const mmX = c.x * p.sizeMm;
        const mmY = -c.y * p.sizeMm; // y-up em -> y-down millimetres
        const pt = reference(p, mmX, mmY);
        expect(pt.x, 'left edge').toBeGreaterThanOrEqual(b.xMm);
        expect(pt.x, 'right edge').toBeLessThanOrEqual(b.xMm + b.wMm);
        expect(pt.y, 'top edge').toBeGreaterThanOrEqual(b.yMm);
        expect(pt.y, 'bottom edge').toBeLessThanOrEqual(b.yMm + b.hMm);
      }
    });
  }

  it('grows by the ink pad on every side', () => {
    const p = placement();
    const tight = placementBoundsMm(p, 0);
    const padded = placementBoundsMm(p, 0.5);
    expect(padded.xMm).toBeCloseTo(tight.xMm - 0.5, 12);
    expect(padded.wMm).toBeCloseTo(tight.wMm + 1, 12);
  });

  it('stays small enough to be worth testing at all', () => {
    // A cull that never culls is not a cull. One glyph's bound must not cover a line.
    const b = placementBoundsMm(placement(), 0);
    expect(b.wMm).toBeLessThan(placement().sizeMm * 3);
    expect(b.hMm).toBeLessThan(placement().sizeMm * 3);
  });
});
