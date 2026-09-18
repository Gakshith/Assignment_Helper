/**
 * The user's OWN hand: `profile/<id>/glyphs.json`, produced by the M2 extraction
 * pipeline, turned into the two frozen provider interfaces.
 *
 * This file closes a seam that was open: Python wrote the profile and the browser
 * loader accepted only the reference hand, so M2 produced a profile that nothing could
 * render — and M2 exists precisely so the page is in YOUR handwriting.
 *
 * Invariant I9: a traced profile IS the user's handwriting. It is fetched from the
 * LOCAL server over the session token and never leaves the machine. It is never in the
 * repository and it never becomes a fixture.
 */

import type { GlyphMetricsProvider, GlyphOutlineProvider } from '../geometry';
import type { Mm } from '../units';
import { NoPath2DError, type Hand } from './provider';

export interface TracedContour {
  readonly outer: boolean;
  readonly points: readonly (readonly [number, number])[];
}

export interface TracedVariant {
  readonly index: number;
  readonly advance: number;
  readonly ascent: number;
  readonly descent: number;
  readonly contours: readonly TracedContour[];
}

export interface TracedGlyph {
  readonly ch: string;
  readonly metrics: { readonly advance: number; readonly ascent: number; readonly descent: number };
  readonly variants: readonly TracedVariant[];
}

export interface TracedProfile {
  readonly schemaVersion: number;
  readonly profileId: string;
  readonly unitsPerEm: number;
  readonly status: 'complete' | 'incomplete';
  readonly substitutions: Readonly<Record<string, string>>;
  readonly coverage: { readonly missing: readonly string[]; readonly ratio: number };
  readonly glyphs: Readonly<Record<string, TracedGlyph>>;
}

export const SUPPORTED_PROFILE_SCHEMA = 1;

export class ProfileSchemaTooNew extends Error {
  constructor(found: number, supported: number) {
    super(
      `This profile was written by a newer build (schemaVersion ${found}; this build ` +
        `understands ${supported}). Refusing to guess at a format it does not know. ` +
        `Re-extract the sheet with this build, or upgrade.`,
    );
    this.name = 'ProfileSchemaTooNew';
  }
}

/**
 * Contours to a fillable path, in RAW FONT UNITS.
 *
 * Not normalised to a unit em. Paint builds its matrix with
 * `emToDeviceMatrix(emPx, unitsPerEm)`, which divides by `unitsPerEm` itself — so a
 * path that was already divided gets divided twice and every glyph is drawn at a
 * thousandth of its size. The symptom is a page that loads cleanly, reports no
 * problems, and is blank apart from a few specks.
 *
 * Inner contours are wound OPPOSITE to outer ones so a nonzero fill cuts the hole.
 * Without this the counters of `o`, `a`, `e` and `p` fill solid and the page looks like
 * it was written with a marker that bled — a failure that reads as a style choice
 * rather than as a bug.
 */
export function contoursToPath(contours: readonly TracedContour[], _unitsPerEm: number): Path2D {
  // Same named failure the reference-hand provider raises, for the same reason: a
  // headless environment has no Path2D, and "undefined is not a constructor" says
  // nothing about which subsystem needs a canvas.
  if (typeof Path2D === 'undefined') throw new NoPath2DError();
  const path = new Path2D();
  for (const contour of contours) {
    const pts = contour.outer ? contour.points : [...contour.points].reverse();
    pts.forEach((p, i) => {
      // y-up in font units, exactly as the profile stores it; paint applies the flip
      // and the scale together with the rest of the glyph transform.
      if (i === 0) path.moveTo(p[0], p[1]);
      else path.lineTo(p[0], p[1]);
    });
    path.closePath();
  }
  return path;
}

export function buildTracedHand(profile: TracedProfile): Hand {
  if (profile.schemaVersion > SUPPORTED_PROFILE_SCHEMA) {
    throw new ProfileSchemaTooNew(profile.schemaVersion, SUPPORTED_PROFILE_SCHEMA);
  }
  const upem = profile.unitsPerEm > 0 ? profile.unitsPerEm : 1000;
  const glyphs = profile.glyphs;
  const cache = new Map<string, Path2D>();

  const has = (ch: string): boolean => Object.hasOwn(glyphs, ch);

  const metrics: GlyphMetricsProvider = {
    profileId: profile.profileId,
    has,
    advanceMm: (ch, sizeMm) => ((glyphs[ch]?.metrics.advance ?? 0) / upem) * (sizeMm as Mm),
    ascentMm: (ch, sizeMm) => ((glyphs[ch]?.metrics.ascent ?? 0) / upem) * (sizeMm as Mm),
    descentMm: (ch, sizeMm) => ((glyphs[ch]?.metrics.descent ?? 0) / upem) * (sizeMm as Mm),
    variantCount: (ch) => Math.max(1, glyphs[ch]?.variants.length ?? 1),
    substitute: (ch) => {
      // The table travels WITH the profile, so a substitution is data rather than code
      // and can grow without a rebuild. Never return a substitute the hand also lacks.
      const sub = profile.substitutions[ch];
      return sub && has(sub) ? sub : null;
    },
  };

  const outlines: GlyphOutlineProvider = {
    profileId: profile.profileId,
    unitsPerEm: upem,
    outline: (ch, variant) => {
      const glyph = glyphs[ch];
      if (!glyph || glyph.variants.length === 0) return null;
      const v = glyph.variants[variant % glyph.variants.length];
      if (!v) return null;
      const key = `${ch}::${v.index}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const built = contoursToPath(v.contours, upem);
      cache.set(key, built);
      return built;
    },
  };

  return { metrics, outlines };
}
