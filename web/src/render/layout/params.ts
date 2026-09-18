/**
 * The imperfection model, as numbers.
 *
 * This lives in layout, not paint, because it is geometry — and geometry is what gets
 * snapshot-goldened. If the jitter lived in paint it would be invisible to I1's
 * enforcement mechanism and preview could drift from export without a test noticing.
 *
 * EVERY AMPLITUDE IS IN MILLIMETRES OR DEGREES (invariant I8). There is not a pixel in
 * this file, and the scale factors are ratios.
 *
 * All of it scales off ONE dial. `imperfection = 1 - neatness`, and every amplitude is
 * literally multiplied by it, so `neatness === 1` gives exact zeros rather than small
 * numbers — `x * 0` is exactly `0` in IEEE754 for any finite x. That exactness is the
 * point: "nearly clean" is a different product from "clean".
 */

import type { Mm } from '../units';
import type { ResolvedStyle } from './style';

/**
 * Amplitudes at `neatness = 0` (the messiest pole), before fatigue.
 *
 * Calibrated against the schema's nominal `size_mm = 4.2`, so the offsets are around
 * 3-4% of the em — visible as a wobble, never as a broken word.
 */
export const BASE = {
  /** Per-instance affine offset, x. */
  jitterXMm: 0.18,
  /** Per-instance affine offset, y. Slightly under x: a hand slips sideways more easily than it slips up. */
  jitterYMm: 0.16,
  /** Per-instance rotation. */
  rotDeg: 2.2,
  /** Per-instance non-uniform scale, as a +/- fraction of 1. */
  scaleXVar: 0.055,
  scaleYVar: 0.05,

  /** Baseline drift, SLOW component: the hand rising and falling across the line. */
  driftSlowMm: 0.55,
  /** Baseline drift, FAST component: per-character tremor. */
  driftFastMm: 0.13,

  /** Slant wander along the line and down the page. */
  slantLineDeg: 2.6,
  /** Per-character slant tremor. */
  slantGlyphDeg: 1.1,

  /** Word-gap variation. */
  wordSpaceMm: 0.3,

  /** Maximum horizontal squeeze applied to a glyph at a fully crowded right margin. */
  crowdGlyph: 0.12,
  /** Maximum squeeze applied to a word gap at a fully crowded right margin. Gaps give first. */
  crowdSpace: 0.35,
} as const;

/** Wavelengths for the two smooth (value-noise) signals. In millimetres and in lines. */
export const WAVE = {
  /**
   * The slow drift wavelength. ~34 mm is about five or six words, so a text column shows
   * four or five gentle rises — a hand tiring, not a ripple.
   */
  driftSlowMm: 34,
  /**
   * Each line gets its own disjoint stretch of the noise field. A new line is a new
   * hand movement, so the drift does NOT continue smoothly from the end of one line into
   * the start of the next. The stride exceeds the widest possible line in noise units.
   */
  driftLineStride: 11,
  /** Slant wanders over roughly three lines, so it reads as a drift down the page. */
  slantLinesPerWave: 3,
  /** ...and over roughly half a column within a single line. */
  slantAlongLineMm: 90,
} as const;

export const CROWD = {
  /**
   * Crowding starts once a line is this full. Below it the hand has no reason to
   * compress. Above it the writer can see the margin coming.
   */
  startFill: 0.82,
} as const;

export const FATIGUE = {
  /** Cumulative characters at which fatigue is fully developed. */
  fullChars: 6000,
  /**
   * Quantisation of the fatigue input. See the note on I3 in engine.ts: fatigue is a
   * cross-block coupling by construction, and bucketing is what keeps it from making
   * every keystroke in block 0 perturb block 40.
   */
  bucketChars: 400,
  /** Amplitude multiplier at full fatigue. 1.55x messier by the end of a long document. */
  gain: 0.55,
} as const;

/** The resolved, per-block amplitude set handed to the placer. */
export interface Amplitudes {
  readonly jitterXMm: Mm;
  readonly jitterYMm: Mm;
  readonly rotDeg: number;
  readonly scaleXVar: number;
  readonly scaleYVar: number;
  readonly driftSlowMm: Mm;
  readonly driftFastMm: Mm;
  readonly slantLineDeg: number;
  readonly slantGlyphDeg: number;
  readonly wordSpaceMm: Mm;
  readonly crowdGlyph: number;
  readonly crowdSpace: number;
  /**
   * False at the clean pole. A variant is a fixed perturbation of the outline, so
   * choosing a non-zero one is itself imperfection and must switch off with the rest.
   */
  readonly varyVariants: boolean;
}

/**
 * Fatigue as a 0..1 factor, from the cumulative character count of everything BEFORE
 * this block.
 *
 * Not page index: page index is a function of reflow, so inserting a sentence on page 1
 * would re-roll page 4. Not block ordinal either: with block ordinal a document of 30
 * short blocks degrades faster than a document of 3 long ones, which inverts the intent
 * — "page 3 is worse than page 1" is a claim about how much has been written, not about
 * how many times the author pressed Enter. Cumulative characters is the only one of the
 * three that is both stable under reflow and monotone in work done.
 */
export function fatigueFactor(cumulativeCharsBefore: number): number {
  const bucketed = Math.floor(cumulativeCharsBefore / FATIGUE.bucketChars) * FATIGUE.bucketChars;
  const f = bucketed / FATIGUE.fullChars;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/**
 * `overrides` detaches one knob from the master curve (design B.4). Reading by fixed key
 * name — never by iterating the record — is what keeps this out of I1's way.
 */
function knob(style: ResolvedStyle, key: string, fromDial: number): number {
  const v = style.overrides[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fromDial;
}

export function amplitudesFor(style: ResolvedStyle, cumulativeCharsBefore: number): Amplitudes {
  const imperfection = 1 - style.neatness;
  const fatigue = 1 + FATIGUE.gain * fatigueFactor(cumulativeCharsBefore);
  // One coherent scalar. Raising neatness quietens every channel together, which is what
  // makes the dial read as "the same hand, more careful" and not as a mixer desk.
  const k = imperfection * fatigue;

  return {
    jitterXMm: knob(style, 'jitter_x_mm', BASE.jitterXMm * k),
    jitterYMm: knob(style, 'jitter_y_mm', BASE.jitterYMm * k),
    rotDeg: knob(style, 'rot_deg', BASE.rotDeg * k),
    scaleXVar: knob(style, 'scale_x_var', BASE.scaleXVar * k),
    scaleYVar: knob(style, 'scale_y_var', BASE.scaleYVar * k),
    driftSlowMm: knob(style, 'drift_slow_mm', BASE.driftSlowMm * k),
    driftFastMm: knob(style, 'drift_fast_mm', BASE.driftFastMm * k),
    slantLineDeg: knob(style, 'slant_line_deg', BASE.slantLineDeg * k),
    slantGlyphDeg: knob(style, 'slant_glyph_deg', BASE.slantGlyphDeg * k),
    wordSpaceMm: knob(style, 'word_space_mm', BASE.wordSpaceMm * k),
    // Crowding scales with imperfection but NOT with fatigue: it is a response to the
    // margin arriving, not to how long you have been writing.
    crowdGlyph: knob(style, 'crowd_glyph', BASE.crowdGlyph * imperfection),
    crowdSpace: knob(style, 'crowd_space', BASE.crowdSpace * imperfection),
    varyVariants: imperfection > 0,
  };
}
