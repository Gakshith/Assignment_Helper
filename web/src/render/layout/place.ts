/**
 * Per-glyph placement: where the imperfection model actually lands on the page.
 *
 * ------------------------------------------------------------------------------------
 * THE TRANSFORM CONVENTION — layout and paint must agree, and geometry.ts does not
 * pin it down, so it is stated here and mirrored in the bounding-box maths below.
 *
 *   Every glyph is drawn at its outline's baseline origin, placed at (xMm, baselineYMm),
 *   with the three transforms applied about THAT origin, in this order:
 *
 *       1. scale   (scaleX, scaleY)
 *       2. slant   horizontal shear; a point h above the baseline moves right by
 *                  h * tan(slantDeg), so positive slantDeg leans the top to the RIGHT
 *       3. rotate  rotDeg about the origin, positive = clockwise on screen (y is down)
 *
 * `boxMm` is computed by pushing the glyph's metric box through exactly this chain, so
 * if paint composes the matrix any other way the lasso index will disagree with the ink
 * and gate G15 will give confidently wrong answers.
 * ------------------------------------------------------------------------------------
 *
 * The drift is DUAL-FREQUENCY and that is deliberate. A slow value-noise component
 * wanders across the line — the hand rising and falling — and a fast per-character
 * component sits on top of it. Either one alone reads as machine noise: the slow one
 * alone looks like the page is skewed, the fast one alone looks like film grain. It is
 * the two together that read as handwriting.
 */

import type { GlyphPlacement, GlyphMetricsProvider, LineGeometry } from '../geometry';
import type { Mm, RectMm } from '../units';
import { randInt, randSigned } from '../rng';
import { clamp01, cosDeg, q, sinDeg, smoothstep01, tanDeg } from './mathfns';
import { noise1 } from './noise';
import { CROWD, WAVE, type Amplitudes } from './params';
import type { BrokenLine } from './text';

/** Fallbacks when a provider hands back a non-finite ascent or descent. Ratios of the em. */
const FALLBACK_ASCENT_RATIO = 0.75;
const FALLBACK_DESCENT_RATIO = 0.25;

export interface PlaceLineInput {
  readonly blockId: string;
  readonly lineIndex: number;
  readonly line: BrokenLine;
  /** The unjittered baseline. Per-glyph drift is added on top, per the geometry contract. */
  readonly baselineYMm: Mm;
  readonly xStartMm: Mm;
  readonly columnWidthMm: Mm;
  readonly sizeMm: Mm;
  readonly spaceWidthMm: Mm;
  readonly seed: bigint;
  readonly amps: Amplitudes;
  readonly baseSlantDeg: number;
  /** Running character ordinal within the block. Drives every per-instance draw. */
  readonly charOrdinal: number;
  readonly metrics: GlyphMetricsProvider;
}

export interface PlacedLine {
  readonly geometry: LineGeometry;
  /** Tight AABB of this line's ink, or null for a line with no ink at all. */
  readonly inkBox: RectMm | null;
  readonly nextCharOrdinal: number;
  /** True when a provider returned a non-finite ascent/descent. Surfaces as a problem. */
  readonly badMetrics: boolean;
}

function finiteOr(v: number, fallback: number): { value: number; ok: boolean } {
  return Number.isFinite(v) ? { value: v, ok: true } : { value: fallback, ok: false };
}

/**
 * The tight AABB of one placed glyph, under the transform chain documented above.
 *
 * It is computed from the ALREADY-QUANTISED placement values, not from the internal
 * high-precision ones, so the box describes what paint will actually draw rather than
 * what layout was thinking. An approximate box makes a correct spatial index return
 * wrong answers, which is the worst kind of wrong.
 */
function glyphInkBox(
  p: GlyphPlacement,
  nominalAdvanceMm: Mm,
  ascentMm: Mm,
  descentMm: Mm,
): RectMm {
  const w = nominalAdvanceMm * p.scaleX;
  const top = -ascentMm * p.scaleY;
  const bottom = descentMm * p.scaleY;

  const tanS = tanDeg(p.slantDeg);
  const cos = cosDeg(p.rotDeg);
  const sin = sinDeg(p.rotDeg);

  const xs = [0, w, 0, w];
  const ys = [top, top, bottom, bottom];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < 4; i++) {
    const x0 = xs[i] ?? 0;
    const y0 = ys[i] ?? 0;
    // 2. shear about the baseline origin (the scale in step 1 is already folded into w/top/bottom)
    const xShear = x0 - y0 * tanS;
    // 3. rotate about the same origin
    const xr = xShear * cos - y0 * sin;
    const yr = xShear * sin + y0 * cos;
    const px = p.xMm + xr;
    const py = p.baselineYMm + yr;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }

  return { xMm: minX, yMm: minY, wMm: maxX - minX, hMm: maxY - minY };
}

function unionInto(acc: RectMm | null, r: RectMm): RectMm {
  if (acc === null) return r;
  const x = Math.min(acc.xMm, r.xMm);
  const y = Math.min(acc.yMm, r.yMm);
  return {
    xMm: x,
    yMm: y,
    wMm: Math.max(acc.xMm + acc.wMm, r.xMm + r.wMm) - x,
    hMm: Math.max(acc.yMm + acc.hMm, r.yMm + r.hMm) - y,
  };
}

export function placeLine(input: PlaceLineInput): PlacedLine {
  const {
    blockId,
    lineIndex,
    line,
    baselineYMm,
    xStartMm,
    columnWidthMm,
    sizeMm,
    spaceWidthMm,
    seed,
    amps,
    baseSlantDeg,
    metrics,
  } = input;

  const glyphs: GlyphPlacement[] = [];
  let inkBox: RectMm | null = null;
  let ordinal = input.charOrdinal;
  let badMetrics = false;

  if (line.words.length === 0) {
    return {
      geometry: { blockId, lineIndex, baselineYMm: q(baselineYMm), xMm: q(xStartMm), widthMm: 0, glyphs: [] },
      inkBox: null,
      nextCharOrdinal: ordinal,
      badMetrics: false,
    };
  }

  /**
   * CROWDING (acceptance row 7, first half).
   *
   * How hard this line compresses is a function of THIS LINE'S OWN CONTENT and nothing
   * else — its nominal fill ratio. That is what makes I3 hold: a line whose words did
   * not change does not change, no matter what happened in the block above it.
   */
  const fill = columnWidthMm > 0 ? line.nominalWidthMm / columnWidthMm : 0;
  const crowd = clamp01((fill - CROWD.startFill) / (1 - CROWD.startFill));

  let xCursor = xStartMm;
  let xNominal = 0; // distance along the line in unsqueezed units, drives the ramp

  for (let wi = 0; wi < line.words.length; wi++) {
    const word = line.words[wi];
    if (!word) continue;

    if (wi > 0) {
      // The gap gives before the letters do — that is what a hand does at the margin.
      const t = smoothstep01(columnWidthMm > 0 ? xNominal / columnWidthMm : 0);
      const squeeze = 1 - amps.crowdSpace * crowd * t;
      const jitter = randSigned(seed, 'space.w', ordinal, amps.wordSpaceMm);
      const gap = Math.max(0, spaceWidthMm * squeeze + jitter);
      xCursor += gap;
      xNominal += spaceWidthMm;
      // The gap consumes an ordinal so that adding a word shifts the draws after it in a
      // way that matches the text, rather than aliasing onto the previous word's values.
      ordinal += 1;
    }

    for (const cm of word.chars) {
      const t = smoothstep01(columnWidthMm > 0 ? xNominal / columnWidthMm : 0);
      const squeeze = 1 - amps.crowdGlyph * crowd * t;
      const nominalAdvance = cm.advanceMm;

      if (cm.ch === null) {
        // Row 5, the unsubstitutable case. Reserve the advance so nothing after it moves,
        // emit no ink, and let the block's problem badge do the talking. The block-level
        // problem is raised by the caller from the resolver's report.
        xCursor += nominalAdvance * squeeze;
        xNominal += nominalAdvance;
        ordinal += 1;
        continue;
      }

      const ch = cm.ch;

      // --- the two drift frequencies -------------------------------------------------
      const along = xCursor - xStartMm;
      const driftSlow =
        noise1(seed, 'drift.slow', lineIndex * WAVE.driftLineStride + along / WAVE.driftSlowMm) *
        amps.driftSlowMm;
      const driftFast = randSigned(seed, 'drift.fast', ordinal, amps.driftFastMm);

      // --- slant wanders over the line AND down the page -----------------------------
      const slantWander =
        noise1(
          seed,
          'slant.line',
          lineIndex / WAVE.slantLinesPerWave + along / WAVE.slantAlongLineMm,
        ) * amps.slantLineDeg;
      const slantTremor = randSigned(seed, 'slant.glyph', ordinal, amps.slantGlyphDeg);

      // --- per-instance affine jitter ------------------------------------------------
      const jx = randSigned(seed, 'jit.x', ordinal, amps.jitterXMm);
      const jy = randSigned(seed, 'jit.y', ordinal, amps.jitterYMm);
      const rot = randSigned(seed, 'jit.rot', ordinal, amps.rotDeg);
      const sxJitter = randSigned(seed, 'jit.sx', ordinal, amps.scaleXVar);
      const syJitter = randSigned(seed, 'jit.sy', ordinal, amps.scaleYVar);

      const vCount = metrics.variantCount(ch);
      const variant =
        amps.varyVariants && Number.isInteger(vCount) && vCount > 1
          ? randInt(seed, 'variant', ordinal, vCount)
          : 0;

      const placement: GlyphPlacement = {
        ch,
        xMm: q(xCursor + jx),
        baselineYMm: q(baselineYMm + driftSlow + driftFast + jy),
        sizeMm: q(sizeMm),
        rotDeg: q(rot),
        slantDeg: q(baseSlantDeg + slantWander + slantTremor),
        // The crowd squeeze rides on scaleX as well as on the advance, so the letters
        // genuinely narrow instead of just overlapping.
        scaleX: q((1 + sxJitter) * squeeze),
        scaleY: q(1 + syJitter),
        variant,
        advanceMm: q(nominalAdvance * squeeze),
      };
      glyphs.push(placement);

      const asc = finiteOr(metrics.ascentMm(ch, sizeMm), sizeMm * FALLBACK_ASCENT_RATIO);
      const desc = finiteOr(metrics.descentMm(ch, sizeMm), sizeMm * FALLBACK_DESCENT_RATIO);
      if (!asc.ok || !desc.ok) badMetrics = true;

      inkBox = unionInto(inkBox, glyphInkBox(placement, nominalAdvance, asc.value, desc.value));

      xCursor += nominalAdvance * squeeze;
      xNominal += nominalAdvance;
      ordinal += 1;
    }
  }

  return {
    geometry: {
      blockId,
      lineIndex,
      baselineYMm: q(baselineYMm),
      xMm: q(xStartMm),
      widthMm: q(Math.max(0, xCursor - xStartMm)),
      glyphs,
    },
    inkBox,
    nextCharOrdinal: ordinal,
    badMetrics,
  };
}

/** Exposed for the engine's block-level accumulation. */
export function unionRect(acc: RectMm | null, r: RectMm | null): RectMm | null {
  if (r === null) return acc;
  return unionInto(acc, r);
}

export function quantiseRect(r: RectMm): RectMm {
  return { xMm: q(r.xMm), yMm: q(r.yMm), wMm: q(r.wMm), hMm: q(r.hMm) };
}
