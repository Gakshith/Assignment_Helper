/**
 * The paint engine, against a recording canvas.
 *
 * vitest runs in the node environment (vitest.config.ts), so there is no canvas here. The
 * fakes below are deliberately dumb — they record calls and nothing else. What is being
 * tested is which calls paint makes and in what order, which is exactly the part a
 * screenshot cannot check: a screenshot cannot tell you that the dirty-rect cull ran, only
 * that the page looks right.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PageLayers, Style } from '@/app/contracts';
import type { BlockGeometry, GlyphOutlineProvider, GlyphPlacement, LineGeometry, PageGeometry } from '@/render/geometry';
import type { RectMm } from '@/render/units';
import { OutlinePaintEngine, PaintOutlineError } from '@/render/paint/index';

// --------------------------------------------------------------------------- fakes

class FakePath2D {
  readonly added: unknown[] = [];
  addPath(path: unknown): void {
    this.added.push(path);
  }
}

interface Recorded {
  readonly kind: 'fill' | 'stroke';
  readonly matrix: readonly [number, number, number, number, number, number];
  readonly alpha: number;
  readonly lineWidth: number;
}

class FakeContext {
  globalAlpha = 1;
  lineWidth = 1;
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  lineJoin: CanvasLineJoin = 'miter';
  lineCap: CanvasLineCap = 'butt';

  readonly draws: Recorded[] = [];
  readonly clears: (readonly [number, number, number, number])[] = [];
  readonly clips: (readonly [number, number, number, number])[] = [];
  #matrix: readonly [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  #pendingRect: readonly [number, number, number, number] | null = null;
  #depth = 0;

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.#matrix = [a, b, c, d, e, f];
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.clears.push([x, y, w, h]);
  }
  save(): void {
    this.#depth++;
  }
  restore(): void {
    this.#depth--;
  }
  beginPath(): void {
    this.#pendingRect = null;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.#pendingRect = [x, y, w, h];
  }
  clip(): void {
    if (this.#pendingRect) this.clips.push(this.#pendingRect);
  }
  fill(): void {
    this.draws.push({ kind: 'fill', matrix: this.#matrix, alpha: this.globalAlpha, lineWidth: this.lineWidth });
  }
  stroke(): void {
    this.draws.push({ kind: 'stroke', matrix: this.#matrix, alpha: this.globalAlpha, lineWidth: this.lineWidth });
  }

  /** Non-zero at the end of a paint would mean a leaked clip for the next subsystem. */
  get depth(): number {
    return this.#depth;
  }
}

function fakeLayers(ctx: FakeContext, dpi = 150): PageLayers {
  const canvas = {
    width: 1275,
    height: 1650,
    getContext: () => ctx,
  };
  // A recording double, not a cast that hides a type error: the engine touches exactly
  // `width`, `height` and `getContext('2d')` on the ink layer.
  return {
    pageIndex: 0,
    paper: canvas as unknown as HTMLCanvasElement,
    ink: canvas as unknown as HTMLCanvasElement,
    overlay: canvas as unknown as HTMLCanvasElement,
    dpi,
  };
}

class FakeOutlines implements GlyphOutlineProvider {
  readonly profileId = 'fake';
  readonly unitsPerEm = 1000;
  calls = 0;
  constructor(private readonly absent: ReadonlySet<string> = new Set()) {}
  outline(ch: string, _variant: number): Path2D | null {
    this.calls++;
    if (this.absent.has(ch)) return null;
    return new FakePath2D() as unknown as Path2D;
  }
}

// ------------------------------------------------------------------------- geometry

function glyph(ch: string, xMm: number, baselineYMm: number): GlyphPlacement {
  return {
    ch,
    xMm,
    baselineYMm,
    sizeMm: 4.2,
    rotDeg: 0.9,
    slantDeg: -4,
    scaleX: 1.01,
    scaleY: 0.99,
    variant: ch.charCodeAt(0) % 6,
    advanceMm: 2.3,
  };
}

function line(blockId: string, lineIndex: number, text: string, xMm: number, yMm: number): LineGeometry {
  const glyphs: GlyphPlacement[] = [];
  let x = xMm;
  for (const ch of text) {
    glyphs.push(glyph(ch, x, yMm));
    x += 2.3;
  }
  return { blockId, lineIndex, baselineYMm: yMm, xMm, widthMm: x - xMm, glyphs };
}

function block(blockId: string, yMm: number, lines: readonly LineGeometry[]): BlockGeometry {
  return {
    blockId,
    kind: 'prose',
    boxMm: { xMm: 30, yMm: yMm - 4, wMm: 150, hMm: 4 + lines.length * 7.1 },
    pageIndex: 0,
    lines,
    figures: [],
    fitScale: 1,
  };
}

function page(): PageGeometry {
  return {
    pageIndex: 0,
    widthMm: 215.9,
    heightMm: 279.4,
    blocks: [
      block('b1', 30, [line('b1', 0, 'alpha', 34, 30), line('b1', 1, 'beta', 34, 37.1)]),
      block('b2', 120, [line('b2', 0, 'gamma', 34, 120)]),
    ],
  };
}

const STYLE: Style = { hand: { neatness: 0.5 } };

// ---------------------------------------------------------------------------- tests

const realPath2D = globalThis.Path2D;

beforeAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = FakePath2D;
});

afterAll(() => {
  (globalThis as { Path2D?: unknown }).Path2D = realPath2D;
});

describe('paintInk, whole page', () => {
  it('fills one path per placed glyph', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, new FakeOutlines());
    const fills = ctx.draws.filter((d) => d.kind === 'fill').length;
    expect(fills).toBe('alpha'.length + 'beta'.length + 'gamma'.length);
  });

  it('clears the whole backing store and sets no clip', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, new FakeOutlines());
    expect(ctx.clears).toEqual([[0, 0, 1275, 1650]]);
    expect(ctx.clips).toEqual([]);
  });

  it('balances save/restore, so the next subsystem does not inherit a clip', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, new FakeOutlines());
    expect(ctx.depth).toBe(0);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('produces byte-identical draws on a second run', () => {
    const a = new FakeContext();
    const b = new FakeContext();
    const engine = new OutlinePaintEngine();
    engine.paintInk(fakeLayers(a), page(), STYLE, new FakeOutlines());
    engine.paintInk(fakeLayers(b), page(), STYLE, new FakeOutlines());
    expect(a.draws).toEqual(b.draws);
  });

  it('draws every glyph at full alpha and never strokes at the clean pole', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(
      fakeLayers(ctx),
      page(),
      { hand: { neatness: 1 } },
      new FakeOutlines(),
    );
    expect(ctx.draws.every((d) => d.kind === 'fill')).toBe(true);
    expect(ctx.draws.every((d) => d.alpha === 1)).toBe(true);
  });

  it('varies alpha away from the clean pole', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(
      fakeLayers(ctx),
      page(),
      { hand: { neatness: 0 } },
      new FakeOutlines(),
    );
    const alphas = new Set(ctx.draws.map((d) => d.alpha));
    expect(alphas.size).toBeGreaterThan(5);
    expect([...alphas].every((a) => a > 0.8 && a <= 1)).toBe(true);
  });
});

describe('paintInk, dirty rect (invariant I7)', () => {
  const dirty: RectMm = { xMm: 30, yMm: 116, wMm: 150, hMm: 12 };

  it('skips every block outside the rectangle', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, new FakeOutlines(), dirty);
    expect(ctx.draws.filter((d) => d.kind === 'fill').length).toBe('gamma'.length);
  });

  it('clears and clips only that rectangle, grown by the ink kernel', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, new FakeOutlines(), dirty);
    expect(ctx.clears.length).toBe(1);
    expect(ctx.clips.length).toBe(1);
    const [x, y, w, h] = ctx.clears[0] ?? [0, 0, 0, 0];
    // Grown, so the weight stroke cannot leave a hairline of the previous frame behind.
    expect(x).toBeLessThan((30 / 25.4) * 150);
    expect(y).toBeLessThan((116 / 25.4) * 150);
    expect(w).toBeGreaterThan((150 / 25.4) * 150);
    expect(h).toBeGreaterThan((12 / 25.4) * 150);
    expect(ctx.clips[0]).toEqual([x, y, w, h]);
  });

  it('asks the hand for far fewer outlines than a full page does', () => {
    const full = new FakeOutlines();
    const partial = new FakeOutlines();
    new OutlinePaintEngine().paintInk(fakeLayers(new FakeContext()), page(), STYLE, full);
    new OutlinePaintEngine().paintInk(fakeLayers(new FakeContext()), page(), STYLE, partial, dirty);
    expect(partial.calls).toBeLessThan(full.calls);
  });

  it('draws nothing at all for a rectangle over empty paper', () => {
    const ctx = new FakeContext();
    new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, new FakeOutlines(), {
      xMm: 30,
      yMm: 250,
      wMm: 100,
      hMm: 10,
    });
    expect(ctx.draws).toEqual([]);
    expect(ctx.clears.length).toBe(1);
  });
});

describe('the outline cache', () => {
  it('parses each (character, variant, scale) once, however many instances there are', () => {
    const engine = new OutlinePaintEngine();
    const outlines = new FakeOutlines();
    engine.paintInk(fakeLayers(new FakeContext()), page(), STYLE, outlines);
    const firstPass = outlines.calls;
    engine.paintInk(fakeLayers(new FakeContext()), page(), STYLE, outlines);
    expect(outlines.calls).toBe(firstPass);
    // 'a' appears in "alpha" (twice), "beta" and "gamma" (twice) but is one entry.
    expect(engine.cache.size).toBeLessThan('alphabetagamma'.length);
  });

  it('keeps separate entries for two DPIs of the same page', () => {
    const engine = new OutlinePaintEngine();
    const outlines = new FakeOutlines();
    engine.paintInk(fakeLayers(new FakeContext(), 150), page(), STYLE, outlines);
    const at150 = engine.cache.size;
    engine.paintInk(fakeLayers(new FakeContext(), 600), page(), STYLE, outlines);
    expect(engine.cache.size).toBe(at150 * 2);
  });
});

describe('a missing outline (invariant I5)', () => {
  it('throws, naming the character and how many times it was wanted', () => {
    const ctx = new FakeContext();
    const outlines = new FakeOutlines(new Set(['a']));
    expect(() =>
      new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, outlines),
    ).toThrow(PaintOutlineError);

    try {
      new OutlinePaintEngine().paintInk(fakeLayers(new FakeContext()), page(), STYLE, outlines);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaintOutlineError);
      const missing = (err as PaintOutlineError).missing;
      expect(missing.every((m) => m.ch === 'a')).toBe(true);
      expect(missing.reduce((n, m) => n + m.count, 0)).toBe(5); // alpha x2, beta x1, gamma x2
      expect((err as Error).message).toContain('metrics and outlines have diverged');
    }
  });

  it('still draws every character it CAN draw before it throws', () => {
    const ctx = new FakeContext();
    try {
      new OutlinePaintEngine().paintInk(fakeLayers(ctx), page(), STYLE, new FakeOutlines(new Set(['a'])));
    } catch {
      // expected; the point of the test is what was drawn first.
    }
    expect(ctx.draws.filter((d) => d.kind === 'fill').length).toBe(
      'alphabetagamma'.length - 5,
    );
    expect(ctx.depth).toBe(0);
  });
});
