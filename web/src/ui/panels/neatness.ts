/**
 * One dial, not twenty (VISION, "One dial, not twenty").
 *
 * A single master 0..1 scales every imperfection amplitude COHERENTLY, because in a
 * real hand those things move together. Each parameter still has its own response
 * curve -- baseline drift is the first thing to go and ink pooling is the last --
 * which is what stops the advanced drawer reading as five copies of one slider.
 *
 * Touching a sub-parameter DETACHES it: it stops following the master and is written
 * into `hand.overrides`, which is exactly what that field is for in the schema. The
 * detached state is visible in the UI as a dot, and it survives a round trip through
 * the server because it lives in the document.
 *
 * Pure. No DOM, no fetch, no clock -- so "an active override always detaches" and
 * "the label never reads as a number" are unit tests, not screenshots.
 */

/** `neatness` is 1 = clean, 0 = rushed, matching HandStyle in the schema. */
export const NEATNESS_MIN = 0;
export const NEATNESS_MAX = 1;

export interface NeatnessParam {
  /** The key inside `hand.overrides`. */
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /**
   * Response exponent on (1 - neatness). Below 1 the parameter appears early as the
   * dial leaves "exam final draft"; above 1 it holds back until the rushed end.
   */
  readonly gamma: number;
}

/**
 * The five VISION names as the imperfection stack that the dial drives together:
 * "jitter amplitude, slant variance, spacing entropy, baseline drift and ink pooling".
 */
export const NEATNESS_PARAMS: readonly NeatnessParam[] = [
  {
    id: 'baseline_drift',
    label: 'Baseline drift',
    hint: 'fast per-character wobble plus a slow wander across the line',
    gamma: 0.75,
  },
  {
    id: 'jitter',
    label: 'Per-glyph jitter',
    hint: 'rotation, vertical offset and scale, independent per letter',
    gamma: 0.9,
  },
  {
    id: 'slant_variance',
    label: 'Slant variance',
    hint: 'the angle wanders along a line and between lines',
    gamma: 1.1,
  },
  {
    id: 'spacing_entropy',
    label: 'Spacing entropy',
    hint: 'word gaps vary; lines crowd toward the right margin',
    gamma: 1.25,
  },
  {
    id: 'ink_pooling',
    label: 'Ink pooling',
    hint: 'weight builds where the pen paused or changed direction',
    gamma: 1.45,
  },
];

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The master curve. 0 = no imperfection, 1 = as much as this parameter goes. */
export function masterAmplitude(neatness: number, param: NeatnessParam): number {
  return clamp01((1 - clamp01(neatness)) ** param.gamma);
}

export function isDetached(overrides: Readonly<Record<string, number>>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, id);
}

/** What the renderer would use: the override if there is one, the master curve if not. */
export function effectiveAmplitude(
  neatness: number,
  param: NeatnessParam,
  overrides: Readonly<Record<string, number>>,
): number {
  const own = overrides[param.id];
  return own === undefined ? masterAmplitude(neatness, param) : clamp01(own);
}

export function detach(
  overrides: Readonly<Record<string, number>>,
  id: string,
  value: number,
): Record<string, number> {
  return { ...overrides, [id]: clamp01(value) };
}

export function reattach(
  overrides: Readonly<Record<string, number>>,
  id: string,
): Record<string, number> {
  const next: Record<string, number> = { ...overrides };
  delete next[id];
  return next;
}

export function detachedCount(overrides: Readonly<Record<string, number>>): number {
  return NEATNESS_PARAMS.filter((p) => isDetached(overrides, p.id)).length;
}

/**
 * The poles and the readout are WORDS, never numbers. "0.62" tells you nothing about
 * what a page will look like; "everyday" does. This is also what `aria-valuetext`
 * announces, so the screen-reader user gets the same information as everyone else --
 * a slider that announces "0.62" is strictly worse than one that announces "careful".
 */
const WORDS: readonly { readonly atLeast: number; readonly word: string }[] = [
  { atLeast: 0.9, word: 'exam final draft' },
  { atLeast: 0.7, word: 'careful' },
  { atLeast: 0.45, word: 'everyday' },
  { atLeast: 0.2, word: 'hurried' },
  { atLeast: 0, word: '2am rushed' },
];

export const NEATNESS_POLE_LOW = '2am rushed';
export const NEATNESS_POLE_HIGH = 'exam final draft';

export function neatnessWord(neatness: number): string {
  const value = clamp01(neatness);
  for (const step of WORDS) {
    if (value >= step.atLeast) return step.word;
  }
  return NEATNESS_POLE_LOW;
}

/** What the dial announces. Words plus the override count, because a detached
 *  parameter means the dial no longer describes the whole page. */
export function neatnessValueText(
  neatness: number,
  overrides: Readonly<Record<string, number>>,
): string {
  const count = detachedCount(overrides);
  if (count === 0) return neatnessWord(neatness);
  const noun = count === 1 ? 'detail' : 'details';
  return `${neatnessWord(neatness)}, ${count} ${noun} set independently`;
}

/** Arrow keys, Home and End. Shift for a coarse step, as a slider should. */
export function stepNeatness(current: number, key: string, coarse: boolean): number | null {
  const step = coarse ? 0.1 : 0.02;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp01(current - step);
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp01(current + step);
    case 'PageDown':
      return clamp01(current - 0.1);
    case 'PageUp':
      return clamp01(current + 0.1);
    case 'Home':
      return NEATNESS_MIN;
    case 'End':
      return NEATNESS_MAX;
    default:
      return null;
  }
}
