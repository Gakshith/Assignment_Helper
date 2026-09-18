/**
 * The paper drawing vocabulary, and the mm -> px boundary.
 *
 * Why a vocabulary instead of passing CanvasRenderingContext2D around: invariant I8
 * says every geometry is in millimetres and exactly ONE scale is applied at the canvas
 * boundary. If the drawing code held a real 2D context it could reach for a pixel at
 * any moment and nothing would catch it until gate G16. Here it cannot — `PaperCtx` has
 * no pixel-shaped method — and `WriterPaperCtx` below is the only file in the module
 * that knows what a pixel is.
 *
 * The second reason is testability. `vitest` runs in node with no DOM and no
 * OffscreenCanvas, so the drawing pass runs against a recording `PaperWriter` and the
 * emitted COMMANDS are asserted. See tests/unit/paper.test.ts.
 *
 * `PaperWriter` is deliberately method-shaped (`setFill`, not `fillStyle = `). A
 * mutable property would be invariant, so neither a real CanvasRenderingContext2D nor a
 * node fake could implement it without a cast, and tsconfig is strict.
 */

import { mmToPx, type Mm, type RectMm } from '../units';

export interface ColourStop {
  readonly at: number;
  readonly colour: string;
}

/** Which way a linear gradient runs across its rect. */
export type EdgeDir = 'right' | 'left' | 'down' | 'up';

export interface RadialSpec {
  readonly cxMm: Mm;
  readonly cyMm: Mm;
  readonly innerRMm: Mm;
  readonly outerRMm: Mm;
}

export interface LineSpec {
  readonly x0Mm: Mm;
  readonly y0Mm: Mm;
  readonly x1Mm: Mm;
  readonly y1Mm: Mm;
}

/**
 * A block of procedurally generated speckle, in CELLS rather than pixels. The cell size
 * is physical (grain.ts), so one tile is stretched over the sheet at every DPI and the
 * grain does not get finer when you export.
 */
export interface NoiseTile {
  readonly rgba: Uint8ClampedArray;
  readonly cellsWide: number;
  readonly cellsHigh: number;
}

/** Everything the paper pass is allowed to do. Six verbs, all in millimetres. */
export interface PaperCtx {
  readonly widthMm: Mm;
  readonly heightMm: Mm;
  /** Flat fill of the entire sheet. */
  fillSheet(colour: string): void;
  fillRect(rect: RectMm, colour: string): void;
  strokeLine(line: LineSpec, colour: string, widthMm: Mm): void;
  fillRadial(rect: RectMm, spec: RadialSpec, stops: readonly ColourStop[]): void;
  fillLinear(rect: RectMm, dir: EdgeDir, stops: readonly ColourStop[]): void;
  /** Stretch a noise tile over the whole sheet in `overlay` mode. */
  overlayNoise(tile: NoiseTile, alpha: number): void;
}

export interface RawGradient {
  addColorStop(offset: number, colour: string): void;
}

/**
 * The raster-side primitives, in whatever coordinate system the current transform sets
 * up. Generic in its gradient and image types so a real canvas and a node fake can both
 * implement it exactly, with no `any` and no cast.
 */
export interface PaperWriter<G extends RawGradient, I> {
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  save(): void;
  restore(): void;
  setFill(style: string | G): void;
  setStroke(style: string | G): void;
  setLineWidth(width: number): void;
  setAlpha(alpha: number): void;
  setComposite(mode: string): void;
  setSmoothing(on: boolean): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  createRadialGradient(cx: number, cy: number, r0: number, r1: number): G;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): G;
  drawImage(image: I, dx: number, dy: number, dw: number, dh: number): void;
}

/** Turns a NoiseTile into something the writer's `drawImage` accepts. */
export type NoiseImageFactory<I> = (tile: NoiseTile) => I;

/**
 * The one place millimetres become pixels.
 *
 * `setTransform(s, 0, 0, s, 0, 0)` with `s = mmToPx(1, dpi)` is the single application
 * of I8's conversion: after it, every coordinate, radius and line width handed to the
 * writer is read as millimetres. A rule asked for at 0.16 mm is 0.94 px at 150 DPI and
 * 1.89 px at 300 DPI — proportional, which is precisely what G16 checks and what a
 * `lineWidth = 2` literal would break.
 */
export class WriterPaperCtx<G extends RawGradient, I> implements PaperCtx {
  readonly #w: PaperWriter<G, I>;
  readonly #noiseImage: NoiseImageFactory<I>;
  readonly #scale: number;

  constructor(
    writer: PaperWriter<G, I>,
    readonly widthMm: Mm,
    readonly heightMm: Mm,
    dpi: number,
    noiseImage: NoiseImageFactory<I>,
  ) {
    if (!Number.isFinite(dpi) || dpi <= 0) {
      throw new Error(`paper: dpi must be a positive finite number, got ${dpi}`);
    }
    this.#w = writer;
    this.#noiseImage = noiseImage;
    this.#scale = mmToPx(1, dpi);
    this.#reset();
  }

  /** The scale actually applied at the boundary. Read by the G16 test. */
  get pxPerMm(): number {
    return this.#scale;
  }

  #reset(): void {
    this.#w.setTransform(this.#scale, 0, 0, this.#scale, 0, 0);
    this.#w.setAlpha(1);
    this.#w.setComposite('source-over');
  }

  fillSheet(colour: string): void {
    this.#w.setFill(colour);
    this.#w.fillRect(0, 0, this.widthMm, this.heightMm);
  }

  fillRect(rect: RectMm, colour: string): void {
    this.#w.setFill(colour);
    this.#w.fillRect(rect.xMm, rect.yMm, rect.wMm, rect.hMm);
  }

  strokeLine(line: LineSpec, colour: string, widthMm: Mm): void {
    this.#w.setStroke(colour);
    this.#w.setLineWidth(widthMm);
    this.#w.beginPath();
    this.#w.moveTo(line.x0Mm, line.y0Mm);
    this.#w.lineTo(line.x1Mm, line.y1Mm);
    this.#w.stroke();
  }

  fillRadial(rect: RectMm, spec: RadialSpec, stops: readonly ColourStop[]): void {
    const g = this.#w.createRadialGradient(spec.cxMm, spec.cyMm, spec.innerRMm, spec.outerRMm);
    for (const s of stops) g.addColorStop(s.at, s.colour);
    this.#w.setFill(g);
    this.#w.fillRect(rect.xMm, rect.yMm, rect.wMm, rect.hMm);
  }

  fillLinear(rect: RectMm, dir: EdgeDir, stops: readonly ColourStop[]): void {
    const x1 = rect.xMm + rect.wMm;
    const y1 = rect.yMm + rect.hMm;
    const ends: Record<EdgeDir, readonly [number, number, number, number]> = {
      right: [rect.xMm, 0, x1, 0],
      left: [x1, 0, rect.xMm, 0],
      down: [0, rect.yMm, 0, y1],
      up: [0, y1, 0, rect.yMm],
    };
    const [gx0, gy0, gx1, gy1] = ends[dir];
    const g = this.#w.createLinearGradient(gx0, gy0, gx1, gy1);
    for (const s of stops) g.addColorStop(s.at, s.colour);
    this.#w.setFill(g);
    this.#w.fillRect(rect.xMm, rect.yMm, rect.wMm, rect.hMm);
  }

  overlayNoise(tile: NoiseTile, alpha: number): void {
    if (alpha <= 0) return;
    const image = this.#noiseImage(tile);
    this.#w.save();
    this.#w.setAlpha(alpha);
    this.#w.setComposite('overlay');
    this.#w.setSmoothing(true);
    // Stretched to the sheet in MILLIMETRES, so the speckle keeps its physical size.
    this.#w.drawImage(image, 0, 0, this.widthMm, this.heightMm);
    this.#w.restore();
    this.#reset();
  }
}
