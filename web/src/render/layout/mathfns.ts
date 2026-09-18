/**
 * Bit-reproducible arithmetic for the layout strand. Invariant I1.
 *
 * WHY THIS FILE EXISTS AT ALL — and it is the least obvious constraint in the strand:
 *
 * ECMA-262 does NOT require `Math.sin`, `Math.cos`, `Math.tan`, `Math.exp` or `Math.pow`
 * to be correctly rounded. It says only that they use "an implementation-approximated
 * algorithm". V8, JavaScriptCore and SpiderMonkey are each free to differ in the last
 * ulp, and historically they have. I1 promises byte-identical geometry "on any machine,
 * forever", so a single `Math.sin` in the drift model is a latent, unreproducible,
 * impossible-to-debug golden-snapshot failure on somebody else's browser.
 *
 * So layout uses NO transcendental library call. Everything here is built from `+ - * /`
 * and `Math.floor` / `Math.round` / `Math.abs` / `Math.min` / `Math.max`, all of which
 * ARE exactly specified. The trig is a truncated Taylor series whose error over the
 * angle range layout actually uses (|deg| <= 30) is ~1e-9 — five orders of magnitude
 * below the 1e-4 mm quantisation applied at emit time, so it cannot move an output byte.
 *
 * The same reasoning is why the slow baseline drift is value noise rather than a sine:
 * interpolated `rand()` control points are pure arithmetic, and they read more like a
 * hand wandering than a periodic wave does.
 */

/** π as an exact double literal. `Math.PI` is also exact, but spelling it out keeps this file self-evidently free of library-dependent values. */
export const PI = 3.141592653589793;

export function degToRad(deg: number): number {
  return (deg * PI) / 180;
}

/**
 * sin(x) for x in radians, Taylor to x^9. Error < 1e-9 for |x| <= 0.55 rad (~31 deg),
 * which covers every angle layout produces (slant <= ~20 deg, rotation <= ~3 deg).
 */
export function sinRad(x: number): number {
  const x2 = x * x;
  const x3 = x2 * x;
  const x5 = x3 * x2;
  const x7 = x5 * x2;
  const x9 = x7 * x2;
  return x - x3 / 6 + x5 / 120 - x7 / 5040 + x9 / 362880;
}

/** cos(x) for x in radians, Taylor to x^8. Same accuracy envelope as {@link sinRad}. */
export function cosRad(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  const x6 = x4 * x2;
  const x8 = x4 * x4;
  return 1 - x2 / 2 + x4 / 24 - x6 / 720 + x8 / 40320;
}

export function sinDeg(deg: number): number {
  return sinRad(degToRad(deg));
}

export function cosDeg(deg: number): number {
  return cosRad(degToRad(deg));
}

/**
 * tan as sin/cos rather than its own series: the quotient converges far better over the
 * slant range, and it costs one divide.
 */
export function tanDeg(deg: number): number {
  return sinDeg(deg) / cosDeg(deg);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** Hermite smoothstep on an already-normalised t. Pure arithmetic, hence reproducible. */
export function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * The emit-time quantiser. Every millimetre, degree and scale factor in the output goes
 * through this exactly once.
 *
 * Two jobs. It keeps goldens readable, and it puts a 1e-4 floor under any residual
 * floating-point difference so the geometry is stable against the last ulp of a divide.
 * Negative zero is normalised away because `Object.is(-0, 0)` is false and a stray -0
 * makes a deep-equal determinism assertion fail for no real reason.
 */
export function q(v: number): number {
  if (!Number.isFinite(v)) {
    // I5: no silent failure. A NaN coordinate means an upstream metric was garbage, and
    // silently emitting it would paint a glyph nowhere and report nothing.
    throw new Error(`layout produced a non-finite value (${v}); a metric upstream is invalid`);
  }
  const r = Math.round(v * 10000) / 10000;
  return r === 0 ? 0 : r;
}
