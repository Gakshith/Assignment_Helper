/**
 * A uniform-grid spatial index over block bounding boxes, one per page.
 *
 * Gate G15: lasso hit-test ≤ 2 ms per `pointermove` on a 20-page document, hard fail
 * at 8 ms. The plan is explicit about why that budget is set where it is:
 *
 *   "Against a spatial index this is ~0.05 ms; if it can approach 16 ms the design is
 *    a linear scan and the gate was hiding it."
 *
 * So a linear scan is not an acceptable first implementation here — at 60 fps a
 * pointermove handler has ~16 ms for everything, and a scan that eats it all produces
 * a lasso that feels broken while every unit test passes.
 *
 * A uniform grid rather than a quadtree or an R-tree: blocks on a page are roughly
 * uniform in size and laid out in reading order, which is the case a uniform grid is
 * best at and the case that defeats a quadtree's balance.
 */

import type { BlockGeometry, PageGeometry } from '../../render/geometry';
import type { Mm, RectMm } from '../../render/units';

/** Grid cell size. Comfortably larger than a line, smaller than a paragraph. */
const CELL_MM = 20;

function rectsOverlap(a: RectMm, b: RectMm): boolean {
  return (
    a.xMm < b.xMm + b.wMm &&
    b.xMm < a.xMm + a.wMm &&
    a.yMm < b.yMm + b.hMm &&
    b.yMm < a.yMm + a.hMm
  );
}

function pointInRect(xMm: Mm, yMm: Mm, r: RectMm): boolean {
  return xMm >= r.xMm && xMm <= r.xMm + r.wMm && yMm >= r.yMm && yMm <= r.yMm + r.hMm;
}

class PageIndex {
  readonly #cols: number;
  readonly #rows: number;
  readonly #cells: BlockGeometry[][];

  constructor(page: PageGeometry) {
    this.#cols = Math.max(1, Math.ceil(page.widthMm / CELL_MM));
    this.#rows = Math.max(1, Math.ceil(page.heightMm / CELL_MM));
    this.#cells = Array.from({ length: this.#cols * this.#rows }, () => []);

    for (const block of page.blocks) {
      for (const i of this.#cellsFor(block.boxMm)) {
        // Deliberately arrays, never Sets: iteration order of a Set is insertion order
        // in practice but is not the thing to lean on when the output is user-visible
        // ordering. Blocks arrive in reading order and stay in it.
        this.#cells[i]!.push(block);
      }
    }
  }

  *#cellsFor(r: RectMm): Iterable<number> {
    const c0 = Math.max(0, Math.floor(r.xMm / CELL_MM));
    const c1 = Math.min(this.#cols - 1, Math.floor((r.xMm + r.wMm) / CELL_MM));
    const r0 = Math.max(0, Math.floor(r.yMm / CELL_MM));
    const r1 = Math.min(this.#rows - 1, Math.floor((r.yMm + r.hMm) / CELL_MM));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) yield row * this.#cols + col;
    }
  }

  /** Topmost block containing the point, or null. */
  hit(xMm: Mm, yMm: Mm): BlockGeometry | null {
    const col = Math.floor(xMm / CELL_MM);
    const row = Math.floor(yMm / CELL_MM);
    if (col < 0 || row < 0 || col >= this.#cols || row >= this.#rows) return null;
    const bucket = this.#cells[row * this.#cols + col];
    if (!bucket) return null;
    for (const block of bucket) {
      if (pointInRect(xMm, yMm, block.boxMm)) return block;
    }
    return null;
  }

  /** Every block overlapping the rect, in reading order, deduplicated. */
  hitRect(rect: RectMm): BlockGeometry[] {
    const seen = new Set<string>();
    const out: BlockGeometry[] = [];
    for (const i of this.#cellsFor(rect)) {
      for (const block of this.#cells[i] ?? []) {
        if (seen.has(block.blockId)) continue;
        if (!rectsOverlap(rect, block.boxMm)) continue;
        seen.add(block.blockId);
        out.push(block);
      }
    }
    // Reading order, so a selection always reports top-to-bottom regardless of which
    // grid cell happened to be visited first.
    out.sort((a, b) => a.boxMm.yMm - b.boxMm.yMm || a.boxMm.xMm - b.boxMm.xMm);
    return out;
  }
}

export class SpatialIndex {
  #pages = new Map<number, PageIndex>();

  rebuild(pages: readonly PageGeometry[]): void {
    this.#pages = new Map();
    for (const page of pages) this.#pages.set(page.pageIndex, new PageIndex(page));
  }

  hitTest(xMm: Mm, yMm: Mm, pageIndex: number): string | null {
    return this.#pages.get(pageIndex)?.hit(xMm, yMm)?.blockId ?? null;
  }

  hitTestRect(rect: RectMm, pageIndex: number): string[] {
    return (this.#pages.get(pageIndex)?.hitRect(rect) ?? []).map((b) => b.blockId);
  }

  get pageCount(): number {
    return this.#pages.size;
  }
}
