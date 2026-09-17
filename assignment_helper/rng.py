"""Counter-based PRNG. Invariant I14.

rand(block_seed, purpose, index) -> [0, 1)

Stateless by construction. NEVER a stateful stream: with a stream, inserting one
new jitter call shifts every downstream value and silently re-rolls the whole page.

This file has a bit-for-bit twin at web/src/render/rng.ts. The golden vectors in
tests/unit/test_rng_golden.py are shared by both and must never diverge.
"""

from __future__ import annotations

MASK64 = (1 << 64) - 1
_FNV_OFFSET = 0xCBF29CE484222325
_FNV_PRIME = 0x100000001B3


def fnv1a64(s: str) -> int:
    """FNV-1a over the UTF-8 bytes of s."""
    h = _FNV_OFFSET
    for b in s.encode("utf-8"):
        h = ((h ^ b) * _FNV_PRIME) & MASK64
    return h


def splitmix64(x: int) -> int:
    z = (x + 0x9E3779B97F4A7C15) & MASK64
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
    return (z ^ (z >> 31)) & MASK64


def rand_bits(block_seed: int, purpose: str, index: int) -> int:
    """The raw 64-bit draw. Exposed so the golden-vector test can compare exactly."""
    h = (block_seed & MASK64) ^ fnv1a64(purpose) ^ splitmix64(index & MASK64)
    return splitmix64(h & MASK64)


def rand(block_seed: int, purpose: str, index: int) -> float:
    """Uniform in [0, 1). Top 53 bits, so it is exactly representable as a float."""
    return (rand_bits(block_seed, purpose, index) >> 11) / float(1 << 53)


def rand_range(block_seed: int, purpose: str, index: int, lo: float, hi: float) -> float:
    return lo + (hi - lo) * rand(block_seed, purpose, index)


def rand_int(block_seed: int, purpose: str, index: int, n: int) -> int:
    """Uniform in [0, n). n must be positive."""
    if n <= 0:
        raise ValueError(f"rand_int needs a positive n, got {n}")
    return rand_bits(block_seed, purpose, index) % n
