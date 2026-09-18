/**
 * The cache that gate G4 is really about.
 *
 * G4: the paper layer is <=1200 ms cold and <=5 ms WARM. Five milliseconds is not a
 * fast procedural pass — it is a blit. So the sheet is rendered once into its own
 * raster, kept, and every later `paintPaper` copies it. The kernel calls `paintPaper`
 * on every full invalidation, which is every document change and every selection
 * change; without this the grain pass would run on each keystroke and gate G1 (<=40 ms
 * single-block ink repaint) would be unreachable by a factor of thirty.
 *
 * Keyed on (params, dpi, seed) — `cacheKey` in params.ts folds all three into one
 * string, and the seed is a pure function of the params, so two identical styles share
 * a raster and a changed tint gets a new one.
 *
 * Generic in the raster type so the whole thing is exercised in node with a fake host.
 */

import { drawPaper } from './draw';
import { cacheKey, seedOf, type PaperParams } from './params';
import type { PaperCtx } from './surface';

/**
 * A letter sheet at 300 DPI is 2550 x 3300 px — about 33 MB of RGBA backing store. Three
 * is enough to keep the current style warm while the user flips between two others, and
 * small enough that a style panel being dragged does not accumulate a hundred megabytes.
 */
export const SHEET_CACHE_CAPACITY = 3;

export interface RasterSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** What a host must supply to own rasters: allocate one, and say how big one is. */
export interface SheetHost<R> {
  create(
    params: PaperParams,
    dpi: number,
    size: RasterSize,
  ): { readonly raster: R; readonly ctx: PaperCtx };
  sizeOf(raster: R): RasterSize;
}

export interface SheetStats {
  readonly coldRenders: number;
  readonly cacheHits: number;
}

/** Insertion-ordered LRU. `Map` already keeps insertion order; re-inserting moves to the end. */
class Lru<V> {
  readonly #entries = new Map<string, V>();

  constructor(private readonly capacity: number) {}

  get(key: string): V | undefined {
    const v = this.#entries.get(key);
    if (v === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

export class SheetCache<R> {
  readonly #lru: Lru<R>;
  #coldRenders = 0;
  #cacheHits = 0;

  constructor(
    private readonly host: SheetHost<R>,
    capacity: number = SHEET_CACHE_CAPACITY,
  ) {
    this.#lru = new Lru<R>(capacity);
  }

  get stats(): SheetStats {
    return { coldRenders: this.#coldRenders, cacheHits: this.#cacheHits };
  }

  get size(): number {
    return this.#lru.size;
  }

  /** The rendered sheet for these params at this DPI. Renders it only on a miss. */
  sheet(params: PaperParams, dpi: number, size: RasterSize): R {
    const key = cacheKey(params, dpi);
    const hit = this.#lru.get(key);
    if (hit !== undefined) {
      const had = this.host.sizeOf(hit);
      // The kernel resizes a page's canvases in place on a DPI change and the key
      // carries DPI, so this should always match. It is checked anyway: blitting a
      // stale-sized raster would scale the paper and nothing downstream would notice.
      if (had.widthPx === size.widthPx && had.heightPx === size.heightPx) {
        this.#cacheHits += 1;
        return hit;
      }
    }
    const { raster, ctx } = this.host.create(params, dpi, size);
    drawPaper(ctx, params, seedOf(params));
    this.#lru.set(key, raster);
    this.#coldRenders += 1;
    return raster;
  }
}
