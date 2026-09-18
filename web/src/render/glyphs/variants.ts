/**
 * Variants: the same letter, written six slightly different ways.
 *
 * Under outline-first (plan §C.1) there is no stroke and no pressure, so a variant
 * CANNOT change the letterform — it can only change the transform the letterform is
 * drawn under. That is not a limitation to be worked around; it is the definition the
 * geometry contract gives ("a variant is a fixed affine perturbation of the outline,
 * chosen by the counter-based RNG"), and pretending otherwise would mean re-tessellating
 * an outline per instance, which invariant I7 forbids outright.
 *
 * WHY THE VARIANT IS SEEDED FROM THE PROFILE, NOT FROM THE DOCUMENT. A variant belongs
 * to the HAND. "The way this hand writes its third `e`" must be the same claim in every
 * document, on every machine, forever — otherwise the same profile would produce a
 * different alphabet per document and the profile would not be a hand at all. The
 * document's own block seeds decide WHICH variant each instance gets (layout does that,
 * in place.ts); this file decides only what the six variants ARE.
 *
 * The amplitudes are M0's verified values (spikes/m0/index.html, `glyphVariant`), which
 * that spike found hide the outline-repetition tell without breaking the letterforms.
 */

import { fnv1a64, rand } from '../rng';

/**
 * Six. M0 measured this: below about four the repetition is visible in a paragraph, and
 * above about eight the extra shapes cost cache entries without changing the page.
 */
export const VARIANT_COUNT = 6;

/**
 * M0's verified variant amplitudes. Rotation in radians, scales as a +/- fraction of 1,
 * shear in shear units (dx per unit of y).
 */
const AMP = {
  rot: 0.05,
  sx: 0.07,
  sy: 0.09,
  shear: 0.055,
} as const;

/**
 * M0's vertical offset is 0.200 mm at the schema's nominal `hand.size_mm = 4.2`.
 *
 * It is stored here as a RATIO OF THE EM because `GlyphOutlineProvider.outline()` is not
 * given a size — the outline it returns is in em units, and an absolute millimetre inside
 * it would be a unit error waiting to happen (invariant I8: one scale, at the canvas
 * boundary). Expressing it as a ratio also makes it behave correctly when the hand is
 * scaled: a larger hand wobbles proportionally more, which is what a hand does.
 */
const VARIANT_DY_EM = 0.2 / 4.2;

/** A 2x3 affine in y-UP font units, mapping (x, y) to (a x + c y + e, b x + d y + f). */
export interface VariantAffine {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export const IDENTITY_AFFINE: VariantAffine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * The upper bound on how far a variant can push ink away from where the unperturbed
 * metrics say it is, as a ratio of the em. The metrics provider inflates its reported
 * ascent and descent by these so the layout strand's bounding boxes stay conservative:
 * a box that is too tight makes a correct spatial index return confidently wrong answers.
 */
export const VARIANT_SCALE_MAX = 1 + AMP.sy;
export const VARIANT_OFFSET_EM = VARIANT_DY_EM;

/**
 * sin/cos by truncated Taylor series, for the same reason layout/mathfns.ts does it:
 * ECMA-262 does not require `Math.sin` to be correctly rounded, so two engines may
 * disagree in the last ulp. Here that would mean two machines caching subtly different
 * outlines for "the same" variant. |rot| <= 0.05 rad, where three terms are exact to
 * better than 1e-15 — far below anything a rasteriser can express.
 */
function sinSmall(x: number): number {
  const x2 = x * x;
  return x - (x2 * x) / 6 + (x2 * x2 * x) / 120;
}

function cosSmall(x: number): number {
  const x2 = x * x;
  return 1 - x2 / 2 + (x2 * x2) / 24;
}

/**
 * Symmetric and TRIANGULAR over (-1, 1), as two summed uniforms.
 *
 * M0's note, kept because it is the whole reason this is not `randSigned`: a flat uniform
 * makes every variant equally likely to be maximally wrong, which reads as static rather
 * than as a hand. Most variants should be nearly the base shape and a few should be
 * noticeably off.
 */
function tri(seed: bigint, purpose: string, index: number): number {
  return rand(seed, purpose, index) + rand(seed, `${purpose}b`, index) - 1;
}

/** The per-hand seed. Fixed by the profile id, so the alphabet is stable across documents. */
export function variantSeed(profileId: string): bigint {
  return fnv1a64(`glyph-variant:${profileId}`);
}

/**
 * The affine for one (glyph, variant), in y-UP font units.
 *
 * Variant 0 is the IDENTITY on purpose. The clean pole of the neatness dial switches
 * variant selection off entirely (params.ts: `varyVariants = imperfection > 0`, which
 * pins every placement to variant 0), and "clean" has to mean the letterform exactly as
 * the type designer drew it — not a small random perturbation of it. Layout can only
 * deliver that if variant 0 is genuinely unperturbed.
 */
export function variantAffine(
  seed: bigint,
  glyphId: number,
  variant: number,
  unitsPerEm: number,
): VariantAffine {
  if (variant <= 0) return IDENTITY_AFFINE;

  const purpose = `variant:${glyphId}:${variant}`;
  const rot = AMP.rot * tri(seed, purpose, 0);
  const sx = 1 + AMP.sx * tri(seed, purpose, 1);
  const sy = 1 + AMP.sy * tri(seed, purpose, 2);
  const shear = AMP.shear * tri(seed, purpose, 3);
  const dy = VARIANT_DY_EM * unitsPerEm * tri(seed, purpose, 4);

  const cos = cosSmall(rot);
  const sin = sinSmall(rot);

  // rotate . shear . scale, applied in that order to a point, then offset vertically.
  return {
    a: cos * sx,
    b: sin * sx,
    c: sy * (cos * shear - sin),
    d: sy * (sin * shear + cos),
    e: 0,
    f: dy,
  };
}
