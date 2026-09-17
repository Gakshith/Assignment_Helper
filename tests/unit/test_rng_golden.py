"""I14: the counter-based RNG is bit-identical in Python and TypeScript, forever.

The same 125 vectors are checked from the TypeScript side by tests/unit/rng.golden.test.ts.
If these two ever diverge, every rendered page silently differs between the preview and
anything the Python half computes, and nothing else in the suite would notice.
"""

import json
from pathlib import Path

from assignment_helper.rng import rand, rand_bits, rand_int, rand_range

GOLDEN = json.loads((Path(__file__).parent / "rng.golden.json").read_text())


def test_golden_vectors_match():
    for case in GOLDEN["cases"]:
        seed, purpose, index = int(case["seed"]), case["purpose"], case["index"]
        assert rand_bits(seed, purpose, index) == int(case["bits"]), case
        assert rand(seed, purpose, index) == case["value"], case


def test_range_is_half_open_unit_interval():
    for i in range(5000):
        v = rand(12345, "spread", i)
        assert 0.0 <= v < 1.0


def test_stateless_not_a_stream():
    # The whole point of I14. Reading index 7 must not depend on having read 0..6,
    # and inserting a new call at index 3 must not shift index 4.
    a = [rand(99, "jitter.x", i) for i in range(10)]
    b = [rand(99, "jitter.x", i) for i in reversed(range(10))][::-1]
    assert a == b
    assert rand(99, "jitter.x", 4) == a[4]


def test_purpose_separates_streams():
    assert rand(1, "jitter.x", 0) != rand(1, "jitter.y", 0)


def test_rand_int_bounds_and_rejects_zero():
    for i in range(1000):
        assert 0 <= rand_int(7, "variant", i, 8) < 8
    try:
        rand_int(7, "variant", 0, 0)
    except ValueError:
        pass
    else:
        raise AssertionError("rand_int(0) must raise, not silently return 0")


def test_rand_range():
    for i in range(1000):
        assert -2.0 <= rand_range(3, "drift", i, -2.0, 2.0) <= 2.0
