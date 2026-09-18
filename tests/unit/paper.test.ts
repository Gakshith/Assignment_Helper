/**
 * Paper engine tests.
 *
 * `vitest` runs in node: no DOM, no OffscreenCanvas, and `'OffscreenCanvas' in
 * globalThis` is false. Rather than skip the render path, the module is built so the
 * host is injectable, and these tests drive it with a RECORDING writer and assert the
 * emitted commands. That is strictly more than a pixel diff would give on the one test
 * that matters most here — the G16/I8 test can check that the millimetre coordinates
 * are IDENTICAL at 150 and 300 DPI and that the only thing that changed is the single
 * scale at the boundary, which a pixel comparison could not distinguish from luck.
 *
 * The real pixels are checked separately, in headless Chromium, by looking at them.
 */

import { describe, expect, it } from 'vitest';

import { randBits } from '@/render/rng';
import { RULING, mmToPx, type RectMm } from '@/render/units';
import { drawPaper, RULE_ORIGIN_MM } from '@/render/paper/draw';
import { GRAIN_CELL_MM, grainTile } from '@/render/paper/grain';
import {
  cacheKey,
  paramsKey,
  resolveParams,
  safeTint,
  seedOf,
  type PaperParams,
  type PaperStyleLike,
} from '@/render/paper/params';
import { SheetCache, type RasterSize, type SheetHost } from '@/render/paper/sheet';
import {
  WriterPaperCtx,
  type ColourStop,
  type EdgeDir,
  type NoiseTile,
  type PaperCtx,
  type PaperWriter,
  type RadialSpec,
  type RawGradient,
} from '@/render/paper/surface';

// ---------------------------------------------------------------- recording writer

class RecGradient implements RawGradient {
  readonly stops: string[] = [];
  addColorStop(offset: number, colour: string): void {
    this.stops.push(`${offset}:${colour}`);
  }
  describe(): string {
    return `grad(${this.stops.join(';')})`;
  }
}

/** A cheap order-sensitive checksum, so a tile shows up in the log without 2.7 MB of it. */
function checksum(bytes: Uint8ClampedArray): string {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i += 97) {
    h = Math.imul(h ^ (bytes[i] ?? 0), 16777619) >>> 0;
  }
  return `${bytes.length}:${h.toString(16)}`;
}

class Recorder implements PaperWriter<RecGradient, NoiseTile> {
  readonly log: string[] = [];
  /** Every setTransform scale seen. The G16 test reads this. */
  readonly scales: number[] = [];
  /** Raw (x, y) pairs handed to moveTo/lineTo — in whatever unit the caller used. */
  readonly points: Array<readonly [number, number]> = [];

  #n(v: number): string {
    return Number(v.toFixed(6)).toString();
  }
  #style(s: string | RecGradient): string {
    return typeof s === 'string' ? s : s.describe();
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.scales.push(a);
    this.log.push(`transform ${this.#n(a)} ${b} ${c} ${this.#n(d)} ${e} ${f}`);
  }
  save(): void {
    this.log.push('save');
  }
  restore(): void {
    this.log.push('restore');
  }
  setFill(style: string | RecGradient): void {
    this.log.push(`fill=${this.#style(style)}`);
  }
  setStroke(style: string | RecGradient): void {
    this.log.push(`stroke=${this.#style(style)}`);
  }
  setLineWidth(width: number): void {
    this.log.push(`lineWidth=${this.#n(width)}`);
  }
  setAlpha(alpha: number): void {
    this.log.push(`alpha=${this.#n(alpha)}`);
  }
  setComposite(mode: string): void {
    this.log.push(`composite=${mode}`);
  }
  setSmoothing(on: boolean): void {
    this.log.push(`smoothing=${on}`);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.log.push(`fillRect ${this.#n(x)} ${this.#n(y)} ${this.#n(w)} ${this.#n(h)}`);
  }
  beginPath(): void {
    this.log.push('beginPath');
  }
  moveTo(x: number, y: number): void {
    this.points.push([x, y]);
    this.log.push(`moveTo ${this.#n(x)} ${this.#n(y)}`);
  }
  lineTo(x: number, y: number): void {
    this.points.push([x, y]);
    this.log.push(`lineTo ${this.#n(x)} ${this.#n(y)}`);
  }
  stroke(): void {
    this.log.push('stroke');
  }
  createRadialGradient(cx: number, cy: number, r0: number, r1: number): RecGradient {
    this.log.push(`radial ${this.#n(cx)} ${this.#n(cy)} ${this.#n(r0)} ${this.#n(r1)}`);
    return new RecGradient();
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): RecGradient {
    this.log.push(`linear ${this.#n(x0)} ${this.#n(y0)} ${this.#n(x1)} ${this.#n(y1)}`);
    return new RecGradient();
  }
  drawImage(image: NoiseTile, dx: number, dy: number, dw: number, dh: number): void {
    this.log.push(
      `drawImage ${image.cellsWide}x${image.cellsHigh} ${checksum(image.rgba)} ` +
        `at ${this.#n(dx)} ${this.#n(dy)} ${this.#n(dw)} ${this.#n(dh)}`,
    );
  }
}

function record(style: PaperStyleLike, dpi = 150): { rec: Recorder; params: PaperParams } {
  const params = resolveParams(style);
  const rec = new Recorder();
  const ctx = new WriterPaperCtx(rec, params.widthMm, params.heightMm, dpi, (t) => t);
  drawPaper(ctx, params, seedOf(params));
  return { rec, params };
}

/** Grain off keeps the geometry tests away from a 670k-cell noise pass they don't need. */
const NO_GRAIN = { grain: 0 } as const;

// ---------------------------------------------------------------- determinism

describe('paper determinism', () => {
  it('draws exactly the same sheet twice for the same style and DPI', () => {
    const style: PaperStyleLike = { kind: 'ruled', grain: 0.5, aging: 0.3 };
    const a = record(style);
    const b = record(style);
    expect(a.rec.log.length).toBeGreaterThan(500);
    expect(b.rec.log).toEqual(a.rec.log);
  });

  it('draws a different sheet when the tint changes', () => {
    const a = record({ kind: 'ruled', tint: '#f4f1e9', ...NO_GRAIN });
    const b = record({ kind: 'ruled', tint: '#eceadf', ...NO_GRAIN });
    expect(b.rec.log).not.toEqual(a.rec.log);
  });

  it('re-seeds when the tint changes, so the tone blobs move too', () => {
    const a = resolveParams({ kind: 'plain', tint: '#f4f1e9' });
    const b = resolveParams({ kind: 'plain', tint: '#eceadf' });
    expect(seedOf(b)).not.toEqual(seedOf(a));
    // ...and the same style always lands on the same seed.
    expect(seedOf(resolveParams({ kind: 'plain', tint: '#f4f1e9' }))).toEqual(seedOf(a));
  });

  it('gives a different sheet for a different grain dial', () => {
    const a = record({ kind: 'rough', grain: 0.2 });
    const b = record({ kind: 'rough', grain: 0.9 });
    expect(b.rec.log).not.toEqual(a.rec.log);
  });

  it('keeps the same seed across DPI, so the export shows the preview sheet', () => {
    const p = resolveParams({ kind: 'ruled' });
    expect(cacheKey(p, 150)).not.toEqual(cacheKey(p, 300));
    expect(cacheKey(p, 150)).toContain(seedOf(p).toString(16));
    expect(cacheKey(p, 300)).toContain(seedOf(p).toString(16));
  });
});

// ---------------------------------------------------------------- I8 / G16

describe('millimetre geometry (I8 / G16)', () => {
  it('lands the rules at the same millimetres at 150 and 300 DPI', () => {
    const style: PaperStyleLike = { kind: 'ruled', ...NO_GRAIN };
    const lo = record(style, 150);
    const hi = record(style, 300);

    // The ONLY difference between the two runs is the single scale at the boundary.
    expect(lo.rec.scales.every((s) => s === mmToPx(1, 150))).toBe(true);
    expect(hi.rec.scales.every((s) => s === mmToPx(1, 300))).toBe(true);
    expect(mmToPx(1, 300)).toBeCloseTo(2 * mmToPx(1, 150), 12);

    // Every coordinate handed to the writer is identical, because it is millimetres.
    expect(hi.rec.points).toEqual(lo.rec.points);

    // And a pixel literal anywhere would have broken that equality, so the drawing
    // pass genuinely has none.
    const withoutTransforms = (r: Recorder): string[] =>
      r.log.filter((l) => !l.startsWith('transform '));
    expect(withoutTransforms(hi.rec)).toEqual(withoutTransforms(lo.rec));
  });

  it('puts the red margin rule at 31.75 mm — 187.5 px at 150 DPI, 375 px at 300', () => {
    const { rec, params } = record({ kind: 'ruled', ...NO_GRAIN }, 150);
    const xMm = RULING.college.marginFromLeftMm;
    expect(xMm).toBe(31.75);

    const vertical = rec.points.filter(
      ([x, y]) => Math.abs(x - xMm) < 1e-9 && (y === 0 || Math.abs(y - params.heightMm) < 1e-9),
    );
    // One moveTo at the top edge and one lineTo at the bottom: full page height.
    expect(vertical).toEqual([
      [xMm, 0],
      [xMm, params.heightMm],
    ]);

    expect(mmToPx(xMm, 150)).toBeCloseTo(187.5, 10);
    expect(mmToPx(xMm, 300)).toBeCloseTo(375, 10);
  });

  it('rules the page at the college 7.1 mm pitch, full width', () => {
    const { rec, params } = record({ kind: 'ruled', ...NO_GRAIN }, 150);
    const ys = rec.points
      .filter(([x]) => x === 0)
      .map(([, y]) => y)
      .filter((y) => y >= RULE_ORIGIN_MM);
    const unique = [...new Set(ys)].sort((a, b) => a - b);
    expect(unique.length).toBeGreaterThan(30);
    expect(unique[0]).toBeCloseTo(RULE_ORIGIN_MM, 10);
    for (let i = 1; i < unique.length; i++) {
      expect((unique[i] ?? 0) - (unique[i - 1] ?? 0)).toBeCloseTo(RULING.college.pitchMm, 10);
    }
    // Full page width: every rule runs 0 -> widthMm.
    const spans = rec.points.filter(([, y]) => y === (unique[0] ?? -1));
    expect(spans).toEqual([
      [0, unique[0]],
      [params.widthMm, unique[0]],
    ]);
  });

  it('rules wide paper at 8.7 mm and grid paper on a 5 mm lattice', () => {
    const wide = record({ kind: 'ruled', ruling: 'wide', ...NO_GRAIN }, 150);
    const wideYs = [
      ...new Set(
        wide.rec.points.filter(([x]) => x === 0).map(([, y]) => y).filter((y) => y >= RULE_ORIGIN_MM),
      ),
    ].sort((a, b) => a - b);
    expect((wideYs[1] ?? 0) - (wideYs[0] ?? 0)).toBeCloseTo(RULING.wide.pitchMm, 10);

    const grid = record({ kind: 'grid', ...NO_GRAIN }, 150);
    const xs = [...new Set(grid.rec.points.filter(([, y]) => y === 0).map(([x]) => x))].sort(
      (a, b) => a - b,
    );
    expect(xs[0]).toBeCloseTo(5, 10);
    expect((xs[1] ?? 0) - (xs[0] ?? 0)).toBeCloseTo(5, 10);
    // grid5 has no margin rule, so nothing is drawn at 31.75 mm.
    expect(grid.rec.log.some((l) => l.includes('rgba(206,116,116'))).toBe(false);
  });

  it('keeps the grain cell physical, so the tile is the same at every DPI', () => {
    const p = resolveParams({ kind: 'plain' });
    const tile = grainTile(seedOf(p), p.widthMm, p.heightMm);
    expect(tile.cellsWide).toBe(Math.round(p.widthMm / GRAIN_CELL_MM));
    expect(tile.cellsHigh).toBe(Math.round(p.heightMm / GRAIN_CELL_MM));
    // 0.3 mm cells over a 215.9 mm sheet.
    expect(tile.cellsWide).toBe(720);
  });
});

// ---------------------------------------------------------------- the four surfaces

describe('the four surfaces', () => {
  const kinds = ['ruled', 'plain', 'grid', 'rough'] as const;

  for (const kind of kinds) {
    it(`renders ${kind} without throwing`, () => {
      const { rec } = record({ kind, grain: 0.5, aging: 0.4 });
      expect(rec.log.length).toBeGreaterThan(100);
      // Every surface starts with a flat tint fill of the whole sheet.
      expect(rec.log[1]).toBe('alpha=1');
      expect(rec.log).toContain('fill=#f4f1e9');
    });
  }

  it('gives ruled paper blue rules and a red margin rule; plain paper neither', () => {
    const ruled = record({ kind: 'ruled', ...NO_GRAIN });
    expect(ruled.rec.log).toContain('stroke=rgba(122,150,190,0.52)');
    expect(ruled.rec.log).toContain('stroke=rgba(206,116,116,0.62)');

    const plain = record({ kind: 'plain', ...NO_GRAIN });
    expect(plain.rec.log.some((l) => l.startsWith('stroke='))).toBe(false);
  });

  it('gives rough paper heavier fibre and a ragged edge that plain does not have', () => {
    const plain = record({ kind: 'plain', grain: 0.6 });
    const rough = record({ kind: 'rough', grain: 0.6 });
    const strokes = (r: Recorder): number => r.log.filter((l) => l === 'stroke').length;
    expect(strokes(rough.rec)).toBeGreaterThan(strokes(plain.rec) * 2);
    expect(rough.rec.log).toContain('fill=rgba(255,253,246,0.34)');
    expect(plain.rec.log).not.toContain('fill=rgba(255,253,246,0.34)');
  });

  it('never paints a dark sheet — the page does not invert in dark mode', () => {
    for (const kind of kinds) {
      const { rec } = record({ kind, ...NO_GRAIN });
      const sheetFill = rec.log.find((l) => l.startsWith('fill=#'));
      expect(sheetFill).toBe('fill=#f4f1e9');
    }
  });
});

// ---------------------------------------------------------------- grain / RNG

describe('grain uses the frozen counter-based PRNG', () => {
  it('slices randBits exactly — it is not a second generator', () => {
    const seed = seedOf(resolveParams({ kind: 'plain' }));
    const tile = grainTile(seed, 30, 30);
    const bits = randBits(seed, 'paper.grain', 0);
    const lo = Number(bits & 0xffffffffn);
    const hi = Number((bits >> 32n) & 0xffffffffn);
    for (let k = 0; k < 8; k++) {
      const half = k < 4 ? lo : hi;
      const expected = (half >>> ((k & 3) * 8)) & 0xff;
      expect(tile.rgba[k * 4]).toBe(expected);
      expect(tile.rgba[k * 4 + 1]).toBe(expected);
      expect(tile.rgba[k * 4 + 3]).toBe(255);
    }
  });

  it('is deterministic and seed-sensitive', () => {
    const a = grainTile(1234n, 40, 40);
    const b = grainTile(1234n, 40, 40);
    const c = grainTile(1235n, 40, 40);
    expect(checksum(b.rgba)).toBe(checksum(a.rgba));
    expect(checksum(c.rgba)).not.toBe(checksum(a.rgba));
  });

  it('actually varies — it is noise, not a constant fill', () => {
    const tile = grainTile(99n, 40, 40);
    const seen = new Set<number>();
    for (let i = 0; i < tile.rgba.length; i += 4) seen.add(tile.rgba[i] ?? -1);
    expect(seen.size).toBeGreaterThan(200);
  });
});

// ---------------------------------------------------------------- the cache (G4 warm)

interface FakeRaster extends RasterSize {
  readonly id: number;
}

function fakeHost(): { host: SheetHost<FakeRaster>; drawn: string[] } {
  const drawn: string[] = [];
  let next = 0;
  const host: SheetHost<FakeRaster> = {
    create(params, dpi, size): { raster: FakeRaster; ctx: PaperCtx } {
      drawn.push(`${paramsKey(params)}@${dpi}`);
      const ctx: PaperCtx = {
        widthMm: params.widthMm,
        heightMm: params.heightMm,
        fillSheet(_c: string): void {},
        fillRect(_r: RectMm, _c: string): void {},
        strokeLine(): void {},
        fillRadial(_r: RectMm, _s: RadialSpec, _st: readonly ColourStop[]): void {},
        fillLinear(_r: RectMm, _d: EdgeDir, _st: readonly ColourStop[]): void {},
        overlayNoise(_t: NoiseTile, _a: number): void {},
      };
      return { raster: { id: next++, ...size }, ctx };
    },
    sizeOf(raster): RasterSize {
      return { widthPx: raster.widthPx, heightPx: raster.heightPx };
    },
  };
  return { host, drawn };
}

const LETTER_150: RasterSize = { widthPx: 1275, heightPx: 1650 };
const LETTER_300: RasterSize = { widthPx: 2550, heightPx: 3300 };

describe('the sheet cache', () => {
  it('renders once and blits after — the second call is free', () => {
    const { host, drawn } = fakeHost();
    const cache = new SheetCache(host);
    const p = resolveParams({ kind: 'ruled' });

    const first = cache.sheet(p, 150, LETTER_150);
    const second = cache.sheet(p, 150, LETTER_150);
    const third = cache.sheet(p, 150, LETTER_150);

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(drawn).toHaveLength(1);
    expect(cache.stats).toEqual({ coldRenders: 1, cacheHits: 2 });
  });

  it('misses on a different DPI and on a different style', () => {
    const { host, drawn } = fakeHost();
    const cache = new SheetCache(host);
    const ruled = resolveParams({ kind: 'ruled' });
    const grid = resolveParams({ kind: 'grid' });

    cache.sheet(ruled, 150, LETTER_150);
    cache.sheet(ruled, 300, LETTER_300);
    cache.sheet(grid, 150, LETTER_150);
    cache.sheet(ruled, 150, LETTER_150);

    expect(drawn).toHaveLength(3);
    expect(cache.stats).toEqual({ coldRenders: 3, cacheHits: 1 });
  });

  it('re-renders rather than blitting a stale-sized raster', () => {
    const { host, drawn } = fakeHost();
    const cache = new SheetCache(host);
    const p = resolveParams({ kind: 'plain' });
    cache.sheet(p, 150, LETTER_150);
    cache.sheet(p, 150, { widthPx: 1275, heightPx: 1651 });
    expect(drawn).toHaveLength(2);
  });

  it('evicts the least recently used sheet rather than growing without bound', () => {
    const { host, drawn } = fakeHost();
    const cache = new SheetCache(host, 2);
    const a = resolveParams({ kind: 'ruled' });
    const b = resolveParams({ kind: 'grid' });
    const c = resolveParams({ kind: 'plain' });

    cache.sheet(a, 150, LETTER_150);
    cache.sheet(b, 150, LETTER_150);
    cache.sheet(a, 150, LETTER_150); // a is now the most recent
    cache.sheet(c, 150, LETTER_150); // evicts b
    expect(cache.size).toBe(2);

    cache.sheet(a, 150, LETTER_150); // still warm
    expect(drawn).toHaveLength(3);
    cache.sheet(b, 150, LETTER_150); // gone
    expect(drawn).toHaveLength(4);
  });
});

// ---------------------------------------------------------------- params (I5)

describe('style resolution refuses to fail silently', () => {
  it('rejects a colour Canvas2D would quietly ignore', () => {
    // Canvas keeps the PREVIOUS fillStyle for an unparseable colour and draws on in the
    // wrong shade. That is the failure I5 exists to catch.
    expect(() => resolveParams({ kind: 'ruled', tint: 'not a colour' })).toThrow(/not a colour/);
    expect(() => resolveParams({ kind: 'ruled', rule_colour: 'blue-ish' })).toThrow(
      /rule_colour/,
    );
    expect(() => resolveParams({ kind: 'ruled', tint: '#f4f1e9' })).not.toThrow();
    expect(() => resolveParams({ kind: 'ruled', tint: 'rgba(20,30,40,0.5)' })).not.toThrow();
  });

  it('saturates a 0..1 dial but throws on a number that is not one', () => {
    expect(resolveParams({ kind: 'plain', grain: 1.7 }).grain).toBe(1);
    expect(resolveParams({ kind: 'plain', aging: -3 }).aging).toBe(0);
    expect(() => resolveParams({ kind: 'plain', grain: Number.NaN })).toThrow(/finite/);
    expect(() => resolveParams({ kind: 'plain', aging: Number.POSITIVE_INFINITY })).toThrow(
      /finite/,
    );
  });

  it('defaults grid paper to the 5 mm lattice and everything else to college', () => {
    expect(resolveParams({ kind: 'grid' }).ruling).toBe('grid5');
    expect(resolveParams({ kind: 'ruled' }).ruling).toBe('college');
    expect(resolveParams(undefined).kind).toBe('ruled');
    expect(resolveParams(undefined).pageSize).toBe('letter');
  });

  it('answers the I6 fallback without throwing, even for a broken tint', () => {
    expect(safeTint({ kind: 'plain', tint: 'not a colour' })).toBeNull();
    expect(safeTint({ kind: 'plain', tint: '#abc' })).toBe('#abc');
    expect(safeTint(undefined)).toBe('#f4f1e9');
  });
});
