/**
 * Value noise over the frozen counter-based RNG.
 *
 * The slow half of the dual-frequency baseline drift needs a signal that wanders
 * smoothly along the line. A sine would do it, but `Math.sin` is not reproducible across
 * engines (see mathfns.ts) and, more to the point, a sine reads as a machine: it is
 * perfectly periodic and the eye finds the period immediately.
 *
 * Value noise fixes both. Draw `randSigned` at integer control points and interpolate
 * with a smoothstep. It is pure arithmetic on top of a stateless PRNG, so it is
 * bit-reproducible, and because the control points are independent draws it has no
 * period at all.
 *
 * Crucially it inherits the counter-based property from rng.ts: `noise1(seed, p, u)`
 * depends only on `u`. Inserting a new jitter call elsewhere in the strand does not
 * shift it, which is the whole reason I14 forbids a stateful stream.
 */

import { randSigned } from '../rng';
import { smoothstep01 } from './mathfns';

/**
 * Smooth noise in roughly [-1, +1] at the real coordinate `u`. One unit of `u` is one
 * control point, so the caller sets the wavelength by scaling `u` on the way in.
 */
export function noise1(seed: bigint, purpose: string, u: number): number {
  const i = Math.floor(u);
  const f = u - i;
  const a = randSigned(seed, purpose, i, 1);
  const b = randSigned(seed, purpose, i + 1, 1);
  return a + (b - a) * smoothstep01(f);
}
