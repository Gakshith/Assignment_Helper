/**
 * Procedural paper speckle.
 *
 * A letter sheet at a 0.30 mm cell is 720 x 931 = 670k cells. Calling `rand()` once per
 * cell would re-hash the purpose string 670k times (fnv1a64 walks the bytes in BigInt
 * arithmetic on every call) and blow gate G4's 1200 ms cold budget on its own.
 *
 * So two hoists, both of which keep the frozen counter-based PRNG as the ONLY source of
 * randomness (invariant I1):
 *
 *   1. `fnv1a64(purpose)` is computed once and reused. This is exactly what `randBits`
 *      does internally, with the loop-invariant lifted out of the loop.
 *   2. One 64-bit draw is sliced into 8 independent bytes. splitmix64's output is
 *      uniformly mixed across all 64 bits, so byte k of draw i is as good a noise
 *      sample as a whole fresh draw would be, and it costs an eighth as much.
 *
 * tests/unit/paper.test.ts pins hoist 1 against `randBits` directly, so this can never
 * quietly drift into being a second, different PRNG.
 */

import { fnv1a64, splitmix64 } from '../rng';
import type { Mm } from '../units';
import type { NoiseTile } from './surface';

const MASK64 = (1n << 64n) - 1n;

/**
 * Physical, not pixel. A 0.30 mm speckle is roughly what a 600 dpi scan of copier stock
 * resolves, and because it is in millimetres the grain does not get finer on export.
 */
export const GRAIN_CELL_MM = 0.3;

const GRAIN_PURPOSE = 'paper.grain';

/** `randBits(seed, purpose, i)` with the purpose hash lifted out of the loop. */
function bitsAt(seed: bigint, purposeHash: bigint, index: number): bigint {
  const h = ((seed & MASK64) ^ purposeHash ^ splitmix64(BigInt(index) & MASK64)) & MASK64;
  return splitmix64(h);
}

/**
 * Greyscale white noise, one byte per cell, to be composited in `overlay` at a low
 * alpha. Full-range on purpose: `overlay` compresses it hard, and a narrow-range tile
 * reads as a flat wash rather than fibre.
 */
export function grainTile(seed: bigint, widthMm: Mm, heightMm: Mm): NoiseTile {
  const cellsWide = Math.max(2, Math.round(widthMm / GRAIN_CELL_MM));
  const cellsHigh = Math.max(2, Math.round(heightMm / GRAIN_CELL_MM));
  const cells = cellsWide * cellsHigh;
  const rgba = new Uint8ClampedArray(cells * 4);
  const purposeHash = fnv1a64(GRAIN_PURPOSE);

  for (let i = 0; i < cells; i += 8) {
    const bits = bitsAt(seed, purposeHash, i >>> 3);
    // Split once into two 32-bit halves, then slice with cheap Number ops rather than
    // eight more BigInt shifts.
    const lo = Number(bits & 0xffffffffn);
    const hi = Number((bits >> 32n) & 0xffffffffn);
    const n = Math.min(8, cells - i);
    for (let k = 0; k < n; k++) {
      const half = k < 4 ? lo : hi;
      const lum = (half >>> ((k & 3) * 8)) & 0xff;
      const o = (i + k) * 4;
      rgba[o] = lum;
      rgba[o + 1] = lum;
      rgba[o + 2] = lum;
      rgba[o + 3] = 255;
    }
  }

  return { rgba, cellsWide, cellsHigh };
}
