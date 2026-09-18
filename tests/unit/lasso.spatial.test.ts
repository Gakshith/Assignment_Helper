/**
 * Gate G15 and the correctness of block selection.
 *
 * The plan is specific about why the G15 budget is where it is: "Against a spatial
 * index this is ~0.05 ms; if it can approach 16 ms the design is a linear scan and the
 * gate was hiding it." So this file measures the real thing on a real 20-page document
 * rather than asserting a property of a toy.
 */

import { describe, expect, it } from 'vitest';
import { SpatialIndex } from '../../web/src/ui/lasso/spatial';
import type { BlockGeometry, PageGeometry } from '../../web/src/render/geometry';

function block(id: string, x: number, y: number, w = 150, h = 6): BlockGeometry {
  return {
    blockId: id,
    kind: 'prose',
    boxMm: { xMm: x, yMm: y, wMm: w, hMm: h },
    pageIndex: 0,
    lines: [],
    figures: [],
    fitScale: 1,
  };
}

function page(pageIndex: number, blocks: BlockGeometry[]): PageGeometry {
  return { pageIndex, widthMm: 215.9, heightMm: 279.4, blocks };
}

/** 20 pages, 40 blocks each — a genuinely large document. */
function bigDocument(): PageGeometry[] {
  return Array.from({ length: 20 }, (_, p) =>
    page(
      p,
      Array.from({ length: 40 }, (_, i) => ({
        ...block(`p${p}b${i}`, 31.75, 25 + i * 6.2),
        pageIndex: p,
      })),
    ),
  );
}

describe('lasso spatial index', () => {
  it('finds the block under a point', () => {
    const idx = new SpatialIndex();
    idx.rebuild([page(0, [block('a', 30, 30), block('b', 30, 60)])]);
    expect(idx.hitTest(50, 33, 0)).toBe('a');
    expect(idx.hitTest(50, 62, 0)).toBe('b');
  });

  it('returns null in empty space rather than the nearest block', () => {
    const idx = new SpatialIndex();
    idx.rebuild([page(0, [block('a', 30, 30)])]);
    expect(idx.hitTest(50, 200, 0)).toBeNull();
    expect(idx.hitTest(-5, -5, 0)).toBeNull();
    expect(idx.hitTest(50, 33, 7)).toBeNull(); // page that does not exist
  });

  it('box-selects every overlapping block, in reading order, with no duplicates', () => {
    const idx = new SpatialIndex();
    idx.rebuild([
      page(0, [block('a', 30, 30), block('b', 30, 60), block('c', 30, 90), block('d', 30, 200)]),
    ]);
    // A block spanning many grid cells must be reported once, not once per cell.
    const hit = idx.hitTestRect({ xMm: 20, yMm: 25, wMm: 170, hMm: 80 }, 0);
    expect(hit).toEqual(['a', 'b', 'c']);
  });

  it('a block wider than a grid cell is still found from any part of it', () => {
    const idx = new SpatialIndex();
    idx.rebuild([page(0, [block('wide', 10, 50, 190, 40)])]);
    for (const x of [12, 60, 120, 195]) {
      expect(idx.hitTest(x, 70, 0)).toBe('wide');
    }
  });

  it('G15 — hit-test on a 20-page document stays far under 2 ms', () => {
    const idx = new SpatialIndex();
    idx.rebuild(bigDocument());
    expect(idx.pageCount).toBe(20);

    const N = 20000;
    const t0 = performance.now();
    let found = 0;
    for (let i = 0; i < N; i++) {
      const y = 25 + (i % 40) * 6.2 + 1;
      if (idx.hitTest(60, y, i % 20) !== null) found++;
    }
    const perCall = (performance.now() - t0) / N;

    expect(found).toBeGreaterThan(N * 0.9);
    // The budget is 2 ms; a linear scan over 800 blocks lands orders of magnitude worse.
    expect(perCall).toBeLessThan(2);
    console.log(`G15 hit-test: ${(perCall * 1000).toFixed(2)} µs per call (budget 2000 µs)`);
  });

  it('G15 — rect-select across a full page also stays under budget', () => {
    const idx = new SpatialIndex();
    idx.rebuild(bigDocument());
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      idx.hitTestRect({ xMm: 20, yMm: 20, wMm: 180, hMm: 250 }, i % 20);
    }
    const perCall = (performance.now() - t0) / N;
    expect(perCall).toBeLessThan(2);
    console.log(`G15 rect-select: ${(perCall * 1000).toFixed(2)} µs per call (budget 2000 µs)`);
  });
});

// ---------------------------------------------------------------- toolbar placement

import { placeToolbar, toolbarState } from '../../web/src/ui/lasso/toolbar';

const TOOLBAR = { width: 260, height: 36 };
const VIEWPORT = { width: 1440, height: 900 };
const TOP_BAR = 48;

describe('selection toolbar placement (§B.4)', () => {
  it('sits centred, 12px above the selection', () => {
    const p = placeToolbar({
      selection: { left: 500, top: 400, width: 200, height: 40 },
      toolbar: TOOLBAR,
      viewport: VIEWPORT,
      topBarH: TOP_BAR,
    });
    expect(p.below).toBe(false);
    expect(p.top).toBe(400 - 12 - 36);
    expect(p.left).toBe(500 + 100 - 130);
  });

  it('flips below when it would collide with the top bar', () => {
    const p = placeToolbar({
      selection: { left: 500, top: 60, width: 200, height: 40 },
      toolbar: TOOLBAR,
      viewport: VIEWPORT,
      topBarH: TOP_BAR,
    });
    expect(p.below).toBe(true);
    // And it must clear the selection rather than sitting on top of it.
    expect(p.top).toBeGreaterThanOrEqual(60 + 40);
  });

  it('never overlaps the selected pixels in either orientation', () => {
    for (const top of [40, 60, 200, 500, 860]) {
      const selection = { left: 400, top, width: 200, height: 40 };
      const p = placeToolbar({ selection, toolbar: TOOLBAR, viewport: VIEWPORT, topBarH: TOP_BAR });
      const toolbarBottom = p.top + TOOLBAR.height;
      const overlaps = toolbarBottom > selection.top && p.top < selection.top + selection.height;
      expect(overlaps).toBe(false);
    }
  });

  it('clamps horizontally inside the canvas at both edges', () => {
    const l = placeToolbar({
      selection: { left: 0, top: 400, width: 40, height: 20 },
      toolbar: TOOLBAR,
      viewport: VIEWPORT,
      topBarH: TOP_BAR,
    });
    expect(l.left).toBeGreaterThanOrEqual(12);

    const r = placeToolbar({
      selection: { left: 1400, top: 400, width: 40, height: 20 },
      toolbar: TOOLBAR,
      viewport: VIEWPORT,
      topBarH: TOP_BAR,
    });
    expect(r.left + TOOLBAR.width).toBeLessThanOrEqual(VIEWPORT.width - 12);
  });

  it('multi-select disables Edit with a reason and leaves the others live', () => {
    const one = toolbarState(1);
    expect(one.actions.every((a) => a.enabled)).toBe(true);

    const many = toolbarState(3);
    const edit = many.actions.find((a) => a.action === 'edit')!;
    expect(edit.enabled).toBe(false);
    expect(edit.reason).toBeTruthy();
    expect(many.actions.filter((a) => a.action !== 'edit').every((a) => a.enabled)).toBe(true);
  });

  it('an empty selection enables nothing', () => {
    expect(toolbarState(0).actions.every((a) => !a.enabled)).toBe(true);
  });
});
