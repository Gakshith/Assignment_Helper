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

describe('applying the hand must not BREAK anything', () => {
  /**
   * The bug this exists for: `__setFontMetrics` replaces a family's whole table, so
   * supplying only the ASCII range deleted every codepoint above 0x7E — 182 of them in
   * Main-Regular alone, including the radical. Every expression with a square root in
   * it then threw `Unsupported symbol \surd`, which is most of a physics problem set.
   *
   * The twelve-expression oracle did not catch it because that file applies the
   * metrics LAST. Order, not coverage. So the oracle runs again here, after.
   */
  const HARD = [
    'v = \\sqrt{2 g d}',
    '\\sqrt{\\frac{a}{b}}',
    '\\int_0^\\infty e^{-x^2}\\,dx',
    '\\sum_{i=1}^{n} i',
    '\\left( \\frac{a}{b} \\right)',
    '\\alpha\\beta\\gamma',
    'a \\approx b \\neq c \\leq d',
    'v = \\sqrt{2(5.20\\ \\text{m/s}^2)(1.85\\ \\text{m})} = 4.39\\ \\text{m/s}',
  ];

  it('every hard expression still typesets AFTER the hand is applied', () => {
    resetHandMetrics();
    const hand = { ...hands('applied-hand', 0.55) };
    for (const tex of HARD) {
      const r = typesetMath(tex, true, 4.2, 200, 3n, hand);
      // PARSING is what broke. Whether a glyph comes out is a coverage question: this
      // synthetic hand has no Greek, so \alpha\beta\gamma correctly yields no glyphs
      // and a `missing` list instead. Conflating the two would make the test pass for
      // the wrong reason on the day coverage changes.
      expect(r.kind, `${tex} -> ${r.kind === 'parse-error' ? r.message : ''}`).toBe('ok');
      if (r.kind === 'ok' && !/alpha|beta|gamma/.test(tex)) {
        expect(r.glyphs.length, tex).toBeGreaterThan(0);
      }
    }
  });

  it('the substitution still actually moves the layout', () => {
    // Both halves matter: merging must not quietly become a no-op that "passes" by
    // leaving Computer Modern in place.
    resetHandMetrics();
    const narrow = typesetMath('abcdef', false, 4.2, 200, 1n, hands('n', 0.30));
    resetHandMetrics();
    const wide = typesetMath('abcdef', false, 4.2, 200, 1n, hands('w', 0.90));
    if (narrow.kind !== 'ok' || wide.kind !== 'ok') throw new Error('expected clean parses');
    expect(wide.widthMm).toBeGreaterThan(narrow.widthMm);
  });
});

function hands(profileId: string, advance: number): GlyphMetricsProvider {
  return {
    profileId,
    has: (ch) => ch.codePointAt(0)! >= 0x20 && ch.codePointAt(0)! < 0x7f,
    advanceMm: (_c, s) => s * advance,
    ascentMm: (_c, s) => s * 0.72,
    descentMm: (_c, s) => s * 0.22,
    variantCount: () => 6,
    substitute: () => null,
  };
}
