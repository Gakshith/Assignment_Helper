/**
 * The traced profile — the user's own hand — becoming the two frozen providers.
 *
 * This seam was open: Python wrote `profile/<id>/glyphs.json` and the browser loader
 * accepted only the reference hand, so M2 produced a profile that nothing could render.
 * M2 exists precisely so the page is in the user's handwriting.
 */

import { describe, expect, it } from 'vitest';
import {
  ProfileSchemaTooNew,
  SUPPORTED_PROFILE_SCHEMA,
  buildTracedHand,
  type TracedProfile,
} from '../../web/src/render/glyphs/traced';

function profile(over: Partial<TracedProfile> = {}): TracedProfile {
  return {
    schemaVersion: SUPPORTED_PROFILE_SCHEMA,
    profileId: 'mine',
    unitsPerEm: 1000,
    status: 'complete',
    substitutions: { '’': "'", '×': '*' },
    coverage: { missing: [], ratio: 1 },
    glyphs: {
      a: {
        ch: 'a',
        metrics: { advance: 500, ascent: 700, descent: 100 },
        variants: [
          { index: 0, advance: 500, ascent: 700, descent: 100, contours: [{ outer: true, points: [[0, 0], [500, 0], [500, 700]] }] },
          { index: 1, advance: 510, ascent: 705, descent: 100, contours: [{ outer: true, points: [[0, 0], [510, 0], [510, 705]] }] },
        ],
      },
      "'": {
        ch: "'",
        metrics: { advance: 200, ascent: 700, descent: 0 },
        variants: [{ index: 0, advance: 200, ascent: 700, descent: 0, contours: [] }],
      },
    },
    ...over,
  };
}

describe('traced hand', () => {
  it('reports metrics in mm, scaled by unitsPerEm', () => {
    const { metrics } = buildTracedHand(profile());
    expect(metrics.profileId).toBe('mine');
    // 500/1000 of a 4 mm em.
    expect(metrics.advanceMm('a', 4)).toBeCloseTo(2, 9);
    expect(metrics.ascentMm('a', 4)).toBeCloseTo(2.8, 9);
    expect(metrics.descentMm('a', 4)).toBeCloseTo(0.4, 9);
  });

  it('knows which characters the hand actually has', () => {
    const { metrics } = buildTracedHand(profile());
    expect(metrics.has('a')).toBe(true);
    expect(metrics.has('z')).toBe(false);
    expect(metrics.variantCount('a')).toBe(2);
  });

  it('substitutes only to a character the hand also has', () => {
    const { metrics } = buildTracedHand(profile());
    // The table says U+2019 -> ' and the hand HAS ', so substitute.
    expect(metrics.substitute('’')).toBe("'");
    // The table says U+00D7 -> * but the hand lacks *, so refuse rather than
    // substituting to something that will itself come back missing.
    expect(metrics.substitute('×')).toBeNull();
    expect(metrics.substitute('q')).toBeNull();
  });

  it('refuses a profile from a newer build instead of guessing', () => {
    // Acceptance row 10's shape: a schemaVersion NEWER than the app is refused with a
    // clear message, never half-read.
    expect(() => buildTracedHand(profile({ schemaVersion: 99 }))).toThrow(ProfileSchemaTooNew);
    try {
      buildTracedHand(profile({ schemaVersion: 99 }));
    } catch (err) {
      expect(String(err)).toContain('newer build');
      expect(String(err)).toContain('Refusing to guess');
    }
  });

  it('a missing glyph returns null rather than an empty path', () => {
    const { outlines } = buildTracedHand(profile());
    // An empty Path2D would draw NOTHING and report success — the blank-glyph failure
    // acceptance row 5 exists to prevent.
    expect(outlines.outline('z', 0)).toBeNull();
  });

  it('variant index wraps rather than falling off the end', () => {
    // node has no Path2D; the point here is the index arithmetic, not the canvas.
    const stub = class { moveTo() {} lineTo() {} closePath() {} };
    const g = globalThis as { Path2D?: unknown };
    const had = g.Path2D;
    g.Path2D = stub;
    try {
      const { outlines } = buildTracedHand(profile());
      // Layout picks a variant with randInt against variantCount, but a profile can be
      // re-extracted with fewer variants while a document still names a high index.
      expect(outlines.outline('a', 7)).not.toBeNull();
    } finally {
      if (had === undefined) delete g.Path2D;
      else g.Path2D = had;
    }
  });

  it('without a canvas it raises a NAMED error, not "undefined is not a constructor"', () => {
    const { outlines } = buildTracedHand(profile());
    expect(() => outlines.outline('a', 0)).toThrow(/Path2D is unavailable/);
  });

  it('reports the profile id so the UI can say whose hand it is', () => {
    const { outlines } = buildTracedHand(profile());
    expect(outlines.profileId).toBe('mine');
    expect(outlines.unitsPerEm).toBe(1000);
  });
});
