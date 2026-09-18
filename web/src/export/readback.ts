/**
 * Invariant I12 — the canvas readback fidelity self-test. Acceptance row 12.
 *
 * Every pixel this pipeline ever sends to the server comes out of `getImageData`. If the
 * browser lies about those pixels — and several browsers lie deliberately — the export
 * is corrupt in a way that looks fine on screen and only shows up in the PDF the
 * professor opens.
 *
 * So before export is offered at all, we draw a known 16x16 pattern, read it straight
 * back, and compare EXACTLY. A single byte out and export stays disabled with a message
 * that names the cause and the fix. Preview is untouched: a noised preview is a slightly
 * grainy screen, a noised export is a corrupted submission.
 *
 * Why the pattern is fully opaque: canvas backing stores are premultiplied, so any alpha
 * below 255 round-trips lossily on conforming browsers too. Testing with translucent
 * pixels would fail everywhere and teach us nothing.
 */

export const READBACK_SIZE = 16;
const PIXELS = READBACK_SIZE * READBACK_SIZE;

/** The minimum of a 2D context this test needs. Real canvases satisfy it structurally. */
export interface ReadbackContext2D {
  fillStyle: string | unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}

export interface ReadbackCanvas {
  width: number;
  height: number;
  getContext(id: '2d'): ReadbackContext2D | null;
}

export class ReadbackFidelityError extends Error {
  readonly code = 'export.readback-unfaithful';

  constructor(readonly detail: string) {
    super(
      'This browser does not return the pixels that were drawn, so an export would ' +
        `produce a corrupted PDF. ${detail} ` +
        'Known causes: canvas fingerprinting protection (Brave "Block fingerprinting", ' +
        'Firefox privacy.resistFingerprinting, Tor Browser), a private/incognito window ' +
        'with canvas isolation, or a privacy extension that adds noise to getImageData. ' +
        'Fix: allow canvas readback for 127.0.0.1, or open the app in a normal window ' +
        'with that extension disabled, then reload. Export stays disabled until this ' +
        'passes; preview is unaffected.',
    );
    this.name = 'ReadbackFidelityError';
  }
}

export class ReadbackUnavailableError extends Error {
  readonly code = 'export.readback-no-context';

  constructor(readonly detail: string) {
    super(
      'Could not obtain a 2D canvas context to verify export fidelity, so export is ' +
        `disabled. ${detail} ` +
        'This usually means canvas is blocked entirely, or the tab ran out of GPU ' +
        'memory. Reload the tab; if it persists, close other tabs and try again.',
    );
    this.name = 'ReadbackUnavailableError';
  }
}

/**
 * The expected 16x16 RGBA buffer. Deterministic, opaque, and deliberately not a flat
 * colour or a gradient: fingerprinting defences perturb low-order bits, which a smooth
 * pattern can hide inside its own rounding.
 */
export function expectedPattern(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(PIXELS * 4);
  for (let i = 0; i < PIXELS; i += 1) {
    out[i * 4 + 0] = (i * 37 + 11) & 0xff;
    out[i * 4 + 1] = (i * 91 + 29) & 0xff;
    out[i * 4 + 2] = (i * 151 + 67) & 0xff;
    out[i * 4 + 3] = 0xff;
  }
  return out;
}

export function paintPattern(ctx: ReadbackContext2D): void {
  const want = expectedPattern();
  for (let i = 0; i < PIXELS; i += 1) {
    const x = i % READBACK_SIZE;
    const y = Math.floor(i / READBACK_SIZE);
    ctx.fillStyle = `rgb(${want[i * 4]}, ${want[i * 4 + 1]}, ${want[i * 4 + 2]})`;
    ctx.fillRect(x, y, 1, 1);
  }
}

export interface ReadbackMismatch {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly channel: 'r' | 'g' | 'b' | 'a';
  readonly expected: number;
  readonly actual: number;
}

const CHANNELS = ['r', 'g', 'b', 'a'] as const;

/** Returns the first mismatching byte, or null when the readback is exact. */
export function findMismatch(
  want: Uint8ClampedArray,
  got: Uint8ClampedArray,
): ReadbackMismatch | null {
  if (got.length !== want.length) {
    return {
      index: -1,
      x: -1,
      y: -1,
      channel: 'r',
      expected: want.length,
      actual: got.length,
    };
  }
  for (let i = 0; i < want.length; i += 1) {
    const a = want[i];
    const b = got[i];
    if (a === undefined || b === undefined || a !== b) {
      const pixel = Math.floor(i / 4);
      return {
        index: pixel,
        x: pixel % READBACK_SIZE,
        y: Math.floor(pixel / READBACK_SIZE),
        channel: CHANNELS[i % 4] ?? 'r',
        expected: a ?? -1,
        actual: b ?? -1,
      };
    }
  }
  return null;
}

/**
 * Run the self-test. Throws `ReadbackFidelityError` on a mismatch and
 * `ReadbackUnavailableError` when there is no context at all — never returns false,
 * never returns a default (I5).
 */
export function runReadbackSelfTest(makeCanvas: (w: number, h: number) => ReadbackCanvas | null): void {
  const canvas = makeCanvas(READBACK_SIZE, READBACK_SIZE);
  if (!canvas) {
    throw new ReadbackUnavailableError('The canvas factory returned nothing.');
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new ReadbackUnavailableError('getContext("2d") returned null.');
  }

  paintPattern(ctx);
  const read = ctx.getImageData(0, 0, READBACK_SIZE, READBACK_SIZE);
  const mismatch = findMismatch(expectedPattern(), read.data);
  if (!mismatch) return;

  if (mismatch.index < 0) {
    throw new ReadbackFidelityError(
      `getImageData returned ${mismatch.actual} bytes for a ${READBACK_SIZE}x${READBACK_SIZE} ` +
        `read, expected ${mismatch.expected}.`,
    );
  }
  throw new ReadbackFidelityError(
    `Pixel (${mismatch.x}, ${mismatch.y}) channel ${mismatch.channel} read back as ` +
      `${mismatch.actual}, but ${mismatch.expected} was drawn.`,
  );
}
