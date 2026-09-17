import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rand, randBits, randInt, randSigned } from '../../web/src/render/rng';

const golden = JSON.parse(
  readFileSync(resolve(__dirname, 'rng.golden.json'), 'utf8'),
) as { cases: { seed: string; purpose: string; index: number; bits: string; value: number }[] };

describe('I14 — counter-based RNG', () => {
  it('matches the Python golden vectors bit-for-bit', () => {
    for (const c of golden.cases) {
      expect(randBits(BigInt(c.seed), c.purpose, c.index).toString()).toBe(c.bits);
      expect(rand(BigInt(c.seed), c.purpose, c.index)).toBe(c.value);
    }
  });

  it('is stateless, not a stream', () => {
    const a = Array.from({ length: 10 }, (_, i) => rand(99n, 'jitter.x', i));
    expect(rand(99n, 'jitter.x', 4)).toBe(a[4]);
  });

  it('randInt refuses a non-positive n rather than returning 0', () => {
    expect(() => randInt(7n, 'variant', 0, 0)).toThrow();
  });

  it('randSigned is centred so the clean pole of the neatness dial is genuinely clean', () => {
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += randSigned(5n, 'jitter.x', i, 1);
    expect(Math.abs(sum / n)).toBeLessThan(0.02);
  });
});
