/**
 * M3's central claim, asserted rather than assumed.
 *
 * `applyHandMetrics` existed, was tested in isolation, and had NO CALLERS — so every
 * expression was laid out against KaTeX's default Computer Modern metrics. The maths
 * rendered and looked plausible, which is precisely why nobody noticed: a failed
 * metrics substitution is not a crash, it is spacing that is subtly wrong for the hand
 * it is drawn in, on a page someone is about to submit.
 *
 * This test fails if the wiring is ever removed again.
 */

import { describe, expect, it } from 'vitest';
import { resetHandMetrics, typesetMath } from '../../web/src/render/layout/math';
import type { GlyphMetricsProvider } from '../../web/src/render/geometry';

function hand(profileId: string, advance: number): GlyphMetricsProvider {
  return {
    profileId,
    has: () => true,
    advanceMm: (_c, s) => s * advance,
    ascentMm: (_c, s) => s * 0.72,
    descentMm: (_c, s) => s * 0.22,
    variantCount: () => 6,
    substitute: () => null,
  };
}

function widthOf(metrics: GlyphMetricsProvider): number {
  const r = typesetMath('\\frac{a}{b} + x^2', true, 4.2, 200, 7n, metrics);
  if (r.kind !== 'ok') throw new Error('expected a clean parse');
  return r.widthMm;
}

describe('the hand drives the TeX layout', () => {
  it('two different hands produce two different layouts', () => {
    resetHandMetrics();
    const narrow = widthOf(hand('narrow-hand', 0.35));
    resetHandMetrics();
    const wide = widthOf(hand('wide-hand', 0.85));

    // If the substitution is not happening, both run against Computer Modern and these
    // are identical to the last decimal place.
    expect(wide).not.toBeCloseTo(narrow, 3);
    expect(wide).toBeGreaterThan(narrow);
  });

  it('switching profile re-applies rather than inheriting the previous hand', () => {
    resetHandMetrics();
    const first = widthOf(hand('hand-one', 0.35));
    // No reset this time: a profile CHANGE must re-apply on its own.
    const second = widthOf(hand('hand-two', 0.85));
    expect(second).not.toBeCloseTo(first, 3);
  });

  it('the same profile twice is stable — applying is idempotent', () => {
    resetHandMetrics();
    const h = hand('stable-hand', 0.5);
    expect(widthOf(h)).toBeCloseTo(widthOf(h), 9);
  });
});
