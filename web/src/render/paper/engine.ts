/**
 * The PaperEngine itself: allocate a raster, draw the sheet once, blit it forever after.
 *
 * This is the only file in the module that touches a real canvas. Everything above it
 * (draw.ts, sheet.ts, grain.ts, params.ts) is host-agnostic and runs in node.
 *
 * Invariant I1 bans clocks and ambient randomness under render/** — and the check for
 * it is a plain grep, so not even a comment here may name one. Nothing in this module
 * measures itself. G4's two numbers are taken from outside the bundle, using the
 * `stats` counter below to tell a cold pass from a warm one.
 */

import type { PageLayers, PaperEngine, Style } from '../../app/contracts';
import { mmToPx } from '../units';
import { DEFAULT_TINT, resolveParams, safeTint } from './params';
import { SheetCache, type RasterSize, type SheetHost, type SheetStats } from './sheet';
import {
  WriterPaperCtx,
  type NoiseTile,
  type PaperCtx,
  type PaperWriter,
} from './surface';

type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface ProceduralPaperEngine extends PaperEngine {
  /** Cold renders vs cache hits. Read by tests and by the G4 harness. */
  readonly stats: SheetStats;
}

// ---------------------------------------------------------------- the writer shim

/**
 * Delegates the drawing vocabulary onto a real 2D context. Dumb by design: all the
 * millimetre logic lives in WriterPaperCtx, and this exists only so that neither a
 * CanvasRenderingContext2D's invariant `fillStyle` property nor its `drawImage`
 * overloads have to be forced into a shape node can also implement.
 */
class CanvasWriter implements PaperWriter<CanvasGradient, CanvasImageSource> {
  constructor(private readonly c: AnyCtx2D) {}

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.c.setTransform(a, b, c, d, e, f);
  }
  save(): void {
    this.c.save();
  }
  restore(): void {
    this.c.restore();
  }
  setFill(style: string | CanvasGradient): void {
    this.c.fillStyle = style;
  }
  setStroke(style: string | CanvasGradient): void {
    this.c.strokeStyle = style;
  }
  setLineWidth(width: number): void {
    this.c.lineWidth = width;
  }
  setAlpha(alpha: number): void {
    this.c.globalAlpha = alpha;
  }
  setComposite(mode: string): void {
    this.c.globalCompositeOperation = mode as GlobalCompositeOperation;
  }
  setSmoothing(on: boolean): void {
    this.c.imageSmoothingEnabled = on;
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.c.fillRect(x, y, w, h);
  }
  beginPath(): void {
    this.c.beginPath();
  }
  moveTo(x: number, y: number): void {
    this.c.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.c.lineTo(x, y);
  }
  stroke(): void {
    this.c.stroke();
  }
  createRadialGradient(cx: number, cy: number, r0: number, r1: number): CanvasGradient {
    return this.c.createRadialGradient(cx, cy, r0, cx, cy, r1);
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient {
    return this.c.createLinearGradient(x0, y0, x1, y1);
  }
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    this.c.drawImage(image, dx, dy, dw, dh);
  }
}

// ---------------------------------------------------------------- raster allocation

interface Allocated {
  readonly image: CanvasImageSource;
  readonly ctx: AnyCtx2D;
}

function allocate(widthPx: number, heightPx: number): Allocated {
  if (widthPx <= 0 || heightPx <= 0) {
    throw new Error(`paper: refusing to allocate a ${widthPx}x${heightPx} raster`);
  }
  if (typeof OffscreenCanvas === 'function') {
    const oc = new OffscreenCanvas(widthPx, heightPx);
    const ctx = oc.getContext('2d');
    if (ctx === null) throw new Error('paper: OffscreenCanvas refused a 2d context');
    return { image: oc, ctx };
  }
  if (typeof document === 'undefined') {
    throw new Error('paper: no OffscreenCanvas and no document to allocate a raster from');
  }
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('paper: canvas refused a 2d context');
  return { image: canvas, ctx };
}

/** The grain tile as something `drawImage` accepts. Cells in, image out. */
function noiseImage(tile: NoiseTile): CanvasImageSource {
  const { image, ctx } = allocate(tile.cellsWide, tile.cellsHigh);
  const data = ctx.createImageData(tile.cellsWide, tile.cellsHigh);
  data.data.set(tile.rgba);
  ctx.putImageData(data, 0, 0);
  return image;
}

interface BrowserRaster extends RasterSize {
  readonly image: CanvasImageSource;
}

const browserHost: SheetHost<BrowserRaster> = {
  create(params, dpi, size): { raster: BrowserRaster; ctx: PaperCtx } {
    const { image, ctx } = allocate(size.widthPx, size.heightPx);
    const paper = new WriterPaperCtx(
      new CanvasWriter(ctx),
      params.widthMm,
      params.heightMm,
      dpi,
      noiseImage,
    );
    return { raster: { image, widthPx: size.widthPx, heightPx: size.heightPx }, ctx: paper };
  },
  sizeOf(raster): RasterSize {
    return { widthPx: raster.widthPx, heightPx: raster.heightPx };
  },
};

// ---------------------------------------------------------------- I6 fallback

/**
 * Invariant I6's fallback: flat tinted paper plus a visible note, never a blank page and
 * never a silent one. The real error goes to the console on its way past — this is a
 * degraded render, not a swallowed exception.
 */
function paintUnavailable(
  ctx: CanvasRenderingContext2D,
  layers: PageLayers,
  style: Style,
  err: unknown,
): void {
  console.error('[paper] procedural paper failed; falling back to flat tinted paper', err);
  const widthPx = layers.paper.width;
  const heightPx = layers.paper.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // `safeTint` never throws: the tint itself may be what broke the render.
  ctx.fillStyle = safeTint(style.paper) ?? DEFAULT_TINT;
  ctx.fillRect(0, 0, widthPx, heightPx);

  const sizeMm = 3.6;
  ctx.fillStyle = '#9c5a2e'; // --accent-warn
  ctx.font = `${mmToPx(sizeMm, layers.dpi)}px system-ui, sans-serif`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('texture unavailable', mmToPx(12, layers.dpi), mmToPx(16, layers.dpi));
  ctx.fillRect(
    mmToPx(12, layers.dpi),
    mmToPx(18, layers.dpi),
    mmToPx(38, layers.dpi),
    mmToPx(0.4, layers.dpi),
  );
}

// ---------------------------------------------------------------- the engine

export function createPaperEngine(): ProceduralPaperEngine {
  const cache = new SheetCache(browserHost);
  return {
    name: 'procedural-paper',
    get stats(): SheetStats {
      return cache.stats;
    },
    paintPaper(layers: PageLayers, style: Style): void {
      const ctx = layers.paper.getContext('2d');
      // Not part of the I6 fallback: with no context there is nothing to draw the
      // fallback onto either, and a page that cannot be painted must be loud.
      if (ctx === null) throw new Error('procedural-paper: no 2d context on the paper layer');
      const size: RasterSize = { widthPx: layers.paper.width, heightPx: layers.paper.height };
      try {
        const params = resolveParams(style.paper);
        const raster = cache.sheet(params, layers.dpi, size);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        // `copy` rather than clearRect + source-over: one pass over the surface instead
        // of two, which is most of the warm number at export DPI, and it leaves nothing
        // of the previous sheet behind even in the sub-pixel sliver at the right edge
        // where the rounded canvas width overshoots 215.9 mm.
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(raster.image, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
      } catch (err) {
        paintUnavailable(ctx, layers, style, err);
      }
    },
  };
}
