/**
 * The dial's model. Node environment, no DOM: these are the claims the design makes,
 * not a screenshot of them.
 */

import { describe, expect, it } from 'vitest';
import {
  NEATNESS_PARAMS,
  NEATNESS_POLE_HIGH,
  NEATNESS_POLE_LOW,
  detach,
  detachedCount,
  effectiveAmplitude,
  isDetached,
  masterAmplitude,
  neatnessValueText,
  neatnessWord,
  reattach,
  stepNeatness,
} from '@/ui/panels/neatness';

const first = NEATNESS_PARAMS[0];
if (!first) throw new Error('NEATNESS_PARAMS is empty');

describe('the master curve', () => {
  it('scales every parameter coherently: clean means no imperfection anywhere', () => {
    for (const param of NEATNESS_PARAMS) {
      expect(masterAmplitude(1, param)).toBe(0);
    }
  });

  it('is maximal for every parameter at the rushed pole', () => {
    for (const param of NEATNESS_PARAMS) {
      expect(masterAmplitude(0, param)).toBe(1);
    }
  });

  it('is monotonic: less neat is never less imperfect', () => {
    for (const param of NEATNESS_PARAMS) {
      let previous = -1;
      for (let neatness = 1; neatness >= 0; neatness -= 0.05) {
        const value = masterAmplitude(neatness, param);
        expect(value).toBeGreaterThanOrEqual(previous);
        previous = value;
      }
    }
  });

  it('gives each parameter its own response, so the drawer is not five copies', () => {
    const midpoints = NEATNESS_PARAMS.map((p) => masterAmplitude(0.5, p));
    expect(new Set(midpoints.map((m) => m.toFixed(4))).size).toBe(NEATNESS_PARAMS.length);
  });

  it('clamps a value that arrived out of range rather than propagating it', () => {
    expect(masterAmplitude(-3, first)).toBe(1);
    expect(masterAmplitude(9, first)).toBe(0);
    expect(masterAmplitude(Number.NaN, first)).toBe(1);
  });
});

describe('detaching a sub-parameter', () => {
  it('starts attached and following the dial', () => {
    expect(isDetached({}, first.id)).toBe(false);
    expect(effectiveAmplitude(0.25, first, {})).toBe(masterAmplitude(0.25, first));
  });

  it('detaches on touch and stops following the dial', () => {
    const overrides = detach({}, first.id, 0.3);
    expect(isDetached(overrides, first.id)).toBe(true);
    expect(effectiveAmplitude(0.25, first, overrides)).toBe(0.3);
    expect(effectiveAmplitude(0.9, first, overrides)).toBe(0.3);
  });

  it('detaches only the parameter that was touched', () => {
    const overrides = detach({}, first.id, 0.3);
    expect(detachedCount(overrides)).toBe(1);
    for (const param of NEATNESS_PARAMS.slice(1)) {
      expect(isDetached(overrides, param.id)).toBe(false);
    }
  });

  it('reattaches by removing the key, not by writing the curve value back', () => {
    const overrides = reattach(detach({}, first.id, 0.3), first.id);
    expect(Object.prototype.hasOwnProperty.call(overrides, first.id)).toBe(false);
    expect(effectiveAmplitude(0.8, first, overrides)).toBe(masterAmplitude(0.8, first));
  });

  it('does not mutate the overrides it was given', () => {
    const before = { [first.id]: 0.4 };
    detach(before, 'other', 0.1);
    reattach(before, first.id);
    expect(before).toEqual({ [first.id]: 0.4 });
  });
});

describe('the poles and the readout are words', () => {
  it('names both poles in words', () => {
    expect(neatnessWord(0)).toBe(NEATNESS_POLE_LOW);
    expect(neatnessWord(1)).toBe(NEATNESS_POLE_HIGH);
  });

  it('never announces a bare number, at any value', () => {
    for (let n = 0; n <= 1.0001; n += 0.01) {
      const text = neatnessValueText(n, {});
      expect(text).not.toMatch(/^[\d.]+$/);
      expect(text.length).toBeGreaterThan(3);
    }
  });

  it('says so when the dial no longer describes the whole page', () => {
    expect(neatnessValueText(0.5, {})).toBe(neatnessWord(0.5));
    expect(neatnessValueText(0.5, { [first.id]: 0.2 })).toContain('1 detail set independently');
    const two = detach(detach({}, NEATNESS_PARAMS[0]!.id, 0.2), NEATNESS_PARAMS[1]!.id, 0.4);
    expect(neatnessValueText(0.5, two)).toContain('2 details set independently');
  });
});

describe('keyboard operation', () => {
  it('moves on both arrow axes and jumps to the poles', () => {
    expect(stepNeatness(0.5, 'ArrowRight', false)).toBeCloseTo(0.52);
    expect(stepNeatness(0.5, 'ArrowUp', false)).toBeCloseTo(0.52);
    expect(stepNeatness(0.5, 'ArrowLeft', false)).toBeCloseTo(0.48);
    expect(stepNeatness(0.5, 'ArrowDown', false)).toBeCloseTo(0.48);
    expect(stepNeatness(0.5, 'Home', false)).toBe(0);
    expect(stepNeatness(0.5, 'End', false)).toBe(1);
  });

  it('takes a coarse step with shift and a page step with PageUp', () => {
    expect(stepNeatness(0.5, 'ArrowRight', true)).toBeCloseTo(0.6);
    expect(stepNeatness(0.5, 'PageUp', false)).toBeCloseTo(0.6);
  });

  it('clamps at the ends instead of wrapping', () => {
    expect(stepNeatness(1, 'ArrowRight', true)).toBe(1);
    expect(stepNeatness(0, 'ArrowLeft', true)).toBe(0);
  });

  it('returns null for a key it does not own, so the event is not swallowed', () => {
    expect(stepNeatness(0.5, 'Tab', false)).toBeNull();
    expect(stepNeatness(0.5, 'a', false)).toBeNull();
  });
});
