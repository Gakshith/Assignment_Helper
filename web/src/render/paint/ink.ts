/**
 * The ink model. M0's verified numbers, and nothing else.
 *
 * ------------------------------------------------------------------------------------
 * WHERE THE RANDOMNESS COMES FROM, AND WHY IT IS NOT `rand()`.
 *
 * Every wobble on the page — position, rotation, slant, scale, which variant — was
 * decided by layout, from the block's seed, and is already sitting in the placement.
 * Paint must not re-roll any of it: layout's values are goldened (I1), and a second roll
 * here would double-apply the imperfection and make preview disagree with export.
 *
 * Ink weight and alpha are the two channels layout does NOT carry, because they are not
 * geometry and `GlyphPlacement` has no field for them. Paint cannot ask the RNG for them
 * either: `rand(blockSeed, purpose, index)` needs a block seed and a character ordinal,
 * and `paintInk` is handed neither — it gets a `PageGeometry`, which has no seeds in it
 * at all. That is not an oversight in the contract; geometry is deliberately seedless so
 * that it is pure data.
 *
 * So the ink draws are a pure function OF THE PLACEMENT ITSELF. Every field of a
 * placement is quantised by layout to 1e-4 (mathfns.ts `q`), so multiplying by 10 000
 * gives exact integers, and an integer hash over those is deterministic on every engine,
 * forever, with no state and no seed. Same placement, same ink — which is exactly the
 * determinism guarantee, reached by the one route paint actually has.
 * ------------------------------------------------------------------------------------
 *
 * WHY THIS IS A FILL PLUS A HAIRLINE STROKE AND NOT A BLEND MODE OR A FILTER.
 * Junction darkening — the small pool of ink where two strokes of a letter cross — comes
 * for free from drawing at alpha < 1 with plain `source-over`: overlapping fills
 * accumulate. A per-glyph `globalCompositeOperation` or `filter` would force the
 * compositor to allocate and blend a layer per glyph, which is O(strokes) work and puts
 * gate G1 out of reach (I7). The weight term is a stroke of the SAME cached path, which
 * is the cheapest way to make the same letter sit heavier or lighter on the page; it is
 * not a centreline stroke, and there is no pressure model until M5.
 */

import type { GlyphPlacement } from '../geometry';
import type { Mm } from '../units';

/** M0 `IMP.inkWeight`: millimetres of extra stroke on the outline, per character. */
export const INK_WEIGHT_MM = 0.03;

/** M0 `IMP.inkAlpha`: how far below 1 the alpha of a character may fall. */
export const INK_ALPHA = 0.17;

/**
 * M0's bias. The draw is `u - 0.45`, not `u - 0.5`, so slightly more than half of all
 * characters come out with a non-positive weight and are never stroked at all. The page
 * reads as a pen that is mostly consistent and occasionally presses, rather than as one
 * that wavers on every letter — and the majority of glyphs skip the stroke call.
 */
const WEIGHT_BIAS = 0.45;

/** The largest half-width the ink can add, for the dirty-rect expansion in engine.ts. */
export const INK_KERNEL_RADIUS_MM: Mm = (INK_WEIGHT_MM * (1 - WEIGHT_BIAS)) / 2;

/** The M0 spike's default ink: blue-black, the colour of a ballpoint on cheap paper. */
export const DEFAULT_INK = '#1B2A63';

export interface InkDraw {
  /** 0..1. Applied with plain `source-over`, so overlaps darken. */
  readonly alpha: number;
  /** Millimetres of stroke to add on top of the fill. <= 0 means fill only. */
  readonly weightMm: Mm;
}

function mix32(x: number): number {
  let v = x >>> 0;
  v = (v ^ (v >>> 16)) >>> 0;
  v = Math.imul(v, 0x7feb352d) >>> 0;
  v = (v ^ (v >>> 15)) >>> 0;
  v = Math.imul(v, 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

/**
 * Quantised to the integer lattice layout already emits on, so the hash input is exact
 * rather than a float that might differ in its last bit between two computations of the
 * "same" value.
 */
function qi(v: number): number {
  return Math.round(v * 10000) | 0;
}

/**
 * A deterministic [0, 1) draw for one placement, in a named lane.
 *
 * Lanes are salted by name rather than by index for the same reason rng.ts is
 * counter-based: adding a third ink channel later must not shift the values of the first
 * two, or every existing page would silently re-ink itself.
 */
function draw(p: GlyphPlacement, lane: number): number {
  let h = mix32(lane * 0x9e3779b1);
  h = mix32(h ^ (p.ch.codePointAt(0) ?? 0));
  h = mix32(h ^ (p.variant | 0));
  h = mix32(h ^ qi(p.xMm));
  h = mix32(h ^ qi(p.baselineYMm));
  h = mix32(h ^ qi(p.rotDeg));
  h = mix32(h ^ qi(p.scaleX));
  return h / 4294967296;
}

/**
 * The ink for one placement.
 *
 * `imperfection` is `1 - neatness`, the master dial. It multiplies both channels, so the
 * clean pole gives `alpha === 1` and `weightMm === 0` EXACTLY — `x * 0` is exactly `0` in
 * IEEE754 for any finite x — rather than "nearly clean", which params.ts is explicit is a
 * different product.
 *
 * Fatigue is NOT applied here. Layout scales its amplitudes by a per-block fatigue factor
 * computed from the cumulative character count before that block, and paint is given a
 * `PageGeometry` with no character counts in it. Rather than invent a page-index proxy —
 * which would be wrong under reflow, for exactly the reasons params.ts gives — the ink
 * channels ride on the master dial alone. The visible consequence is that a long
 * document's ink does not thin with fatigue while its geometry does.
 */
export function inkFor(p: GlyphPlacement, imperfection: number): InkDraw {
  const k = imperfection;
  const weight = INK_WEIGHT_MM * k * (draw(p, 2) - WEIGHT_BIAS);
  return {
    alpha: 1 - INK_ALPHA * k * draw(p, 1),
    // Normalise -0 away, for mathfns.ts's reason: `Object.is(-0, 0)` is false, so a stray
    // negative zero makes a deep-equal determinism assertion fail for nothing. `0 * x` is
    // -0 whenever x is negative, which is most of the time given the bias above.
    weightMm: weight === 0 ? 0 : weight,
  };
}
