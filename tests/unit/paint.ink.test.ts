/**
 * The ink model: deterministic, seedless, and exactly off at the clean pole.
 */

import { describe, expect, it } from 'vitest';
import type { GlyphPlacement } from '@/render/geometry';
import { INK_ALPHA, INK_WEIGHT_MM, inkFor } from '@/render/paint/index';
import { OutlineCache, MAX_ENTRIES } from '@/render/paint/index';

function placement(over: Partial<GlyphPlacement> = {}): GlyphPlacement {
  return {
    ch: 'a',
    xMm: 25.4,
    baselineYMm: 31.75,
    sizeMm: 4.2,
    rotDeg: -1.3,
    slantDeg: -4.2,
    scaleX: 1.02,
    scaleY: 0.98,
    variant: 3,
    advanceMm: 2.4,
    ...over,
  };
}

describe('inkFor', () => {
  it('is a pure function of the placement', () => {
    const a = inkFor(placement(), 0.5);
    const b = inkFor(placement(), 0.5);
    expect(a).toEqual(b);
  });

  it('gives exactly clean ink at neatness 1', () => {
    const ink = inkFor(placement(), 0);
    // Exactly, not nearly: `x * 0` is exactly 0 in IEEE754, and params.ts is explicit
    // that "nearly clean" is a different product from "clean".
    expect(ink.alpha).toBe(1);
    expect(ink.weightMm).toBe(0);
  });

  it('stays inside M0s verified envelope at full imperfection', () => {
    for (let i = 0; i < 400; i++) {
      const ink = inkFor(placement({ xMm: 10 + i * 0.37, variant: i % 6 }), 1);
      expect(ink.alpha).toBeGreaterThan(1 - INK_ALPHA - 1e-12);
      expect(ink.alpha).toBeLessThanOrEqual(1);
      expect(Math.abs(ink.weightMm)).toBeLessThanOrEqual(INK_WEIGHT_MM);
    }
  });

  it('leaves most glyphs unstroked, because the weight draw is biased low', () => {
    let stroked = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (inkFor(placement({ xMm: i * 0.11, baselineYMm: 40 + i * 0.03 }), 1).weightMm > 0) {
        stroked++;
      }
    }
    // M0's bias is `u - 0.45`, so about 55% of characters are never stroked at all.
    expect(stroked / N).toBeGreaterThan(0.35);
    expect(stroked / N).toBeLessThan(0.55);
  });

  it('separates two glyphs that differ only in position', () => {
    const a = inkFor(placement({ xMm: 30 }), 1);
    const b = inkFor(placement({ xMm: 30.0001 }), 1);
    expect(a.alpha).not.toBe(b.alpha);
  });

  it('separates two glyphs that differ only in variant', () => {
    const a = inkFor(placement({ variant: 1 }), 1);
    const b = inkFor(placement({ variant: 2 }), 1);
    expect(a.alpha).not.toBe(b.alpha);
  });

  it('scales linearly with the master dial', () => {
    const full = inkFor(placement(), 1);
    const half = inkFor(placement(), 0.5);
    expect(1 - half.alpha).toBeCloseTo((1 - full.alpha) / 2, 12);
    expect(half.weightMm).toBeCloseTo(full.weightMm / 2, 12);
  });
});

describe('OutlineCache', () => {
  /** A stand-in for Path2D; the cache never looks inside one. */
  const fake = (): Path2D => ({}) as unknown as Path2D;

  it('keys on profile, character, variant and scale independently', () => {
    const keys = new Set([
      OutlineCache.key('p', 'e', 0, 6349),
      OutlineCache.key('q', 'e', 0, 6349),
      OutlineCache.key('p', 'f', 0, 6349),
      OutlineCache.key('p', 'e', 1, 6349),
      OutlineCache.key('p', 'e', 0, 6350),
    ]);
    expect(keys.size).toBe(5);
  });

  it('evicts the least recently USED, not the least recently added', () => {
    const cache = new OutlineCache(2, Infinity);
    cache.set('a', fake());
    cache.set('b', fake());
    expect(cache.get('a')).toBeDefined(); // 'a' is now the newest
    cache.set('c', fake());
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('honours the byte budget as well as the entry count', () => {
    const cache = new OutlineCache(MAX_ENTRIES, 4096); // room for one 3 KB path
    cache.set('a', fake());
    cache.set('b', fake());
    expect(cache.size).toBe(1);
    expect(cache.estimatedBytes).toBeLessThanOrEqual(4096);
  });

  it('does not double-charge a key that is overwritten', () => {
    const cache = new OutlineCache();
    cache.set('a', fake());
    const once = cache.estimatedBytes;
    cache.set('a', fake());
    expect(cache.estimatedBytes).toBe(once);
    expect(cache.size).toBe(1);
  });
});
