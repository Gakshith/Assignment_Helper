/**
 * Counter-based PRNG. Invariant I14.
 *
 *   rand(blockSeed, purpose, index) -> [0, 1)
 *
 * Stateless by construction. NEVER a stateful stream: with a stream, inserting one
 * new jitter call shifts every downstream value and silently re-rolls the whole page.
 *
 * This file has a bit-for-bit twin at assignment_helper/rng.py. The golden vectors in
 * tests/unit/rng.golden.json are shared by both and must never diverge.
 *
 * Leaf module: zero imports, by design (plan §2 module table).
 */

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

const encoder = new TextEncoder();

export function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (const b of encoder.encode(s)) {
    h = ((h ^ BigInt(b)) * FNV_PRIME) & MASK64;
  }
  return h;
}

export function splitmix64(x: bigint): bigint {
  let z = (x + 0x9e3779b97f4a7c15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

export function randBits(blockSeed: bigint, purpose: string, index: number): bigint {
  const h = ((blockSeed & MASK64) ^ fnv1a64(purpose) ^ splitmix64(BigInt(index) & MASK64)) & MASK64;
  return splitmix64(h);
}

/** Uniform in [0, 1). Top 53 bits, so it is exactly representable as a double. */
export function rand(blockSeed: bigint, purpose: string, index: number): number {
  return Number(randBits(blockSeed, purpose, index) >> 11n) / 9007199254740992; // 2^53
}

export function randRange(
  blockSeed: bigint,
  purpose: string,
  index: number,
  lo: number,
  hi: number,
): number {
  return lo + (hi - lo) * rand(blockSeed, purpose, index);
}

/** Uniform in [0, n). n must be a positive integer. */
export function randInt(blockSeed: bigint, purpose: string, index: number, n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`randInt needs a positive integer n, got ${n}`);
  }
  return Number(randBits(blockSeed, purpose, index) % BigInt(n));
}

/**
 * Signed symmetric draw in [-amp, +amp]. The workhorse for jitter: it is centred,
 * so raising the neatness dial to its clean pole genuinely removes the effect
 * rather than biasing the page in one direction.
 */
export function randSigned(
  blockSeed: bigint,
  purpose: string,
  index: number,
  amp: number,
): number {
  return (rand(blockSeed, purpose, index) * 2 - 1) * amp;
}
