/**
 * DEV HARNESS for the paint + glyphs strand. Not part of the app.
 *
 * Nothing imports this and `vite build` never sees it: it is reachable only from
 * `harness.html`, which is served by `vite dev` and is not an input to the production
 * bundle. It exists for two jobs the unit tests cannot do, because vitest runs in Node
 * and Node has no canvas:
 *
 *   1. Put real ink on a real page, so a person can look at it.
 *   2. Measure gates G1 and G3 against a real rasteriser.
 *
 * IT LIVES OUTSIDE `web/src/render/**` ON PURPOSE. Invariant I1 bans `performance.now()`
 * under that tree — instrumentation there would be indistinguishable from a render path
 * that quietly depends on a clock. A harness one directory up can time whatever it likes
 * and cannot be imported by the render code by accident.
 *
 * It also reaches across the layout/paint module boundary, which production code must not
 * do. That IS the point: the boundary is exactly what needs exercising, and a harness that
 * respected it would only be able to test half a page.
 */

import type { Document, Style } from '../../types/document';
import type { DocumentGeometry, PageGeometry, RectMm } from './types';
import { layoutEngine } from '../../render/layout/index';
import { glyphProfileProvider } from '../../render/glyphs/index';
import { OutlinePaintEngine } from '../../render/paint/index';
import { PAGE_SIZES, RULING, mmToPx } from '../../render/units';
import type { GlyphMetricsProvider, GlyphOutlineProvider } from '../../render/geometry';

const DPI = 150;
const PAGE = PAGE_SIZES.letter;

const PROSE = `Physics 221 - Problem Set 7

Worked solutions. Show all reasoning; numerical answers to three significant figures unless stated otherwise.

1. A 2.40 kg block is released from rest on a frictionless incline inclined at 32.0 degrees above the horizontal. Find the speed of the block after it has slid 1.85 m along the surface.

Take the incline surface as the x axis, positive down the slope. The only unbalanced force is the component of weight along the slope, so a = g sin(theta) = (9.81)(sin 32.0) = 5.199 m/s^2. The motion is one dimensional with constant acceleration and zero initial velocity, so v^2 = v0^2 + 2 a d = 0 + 2(5.199)(1.85) = 19.24 m^2/s^2, giving v = 4.39 m/s directed down the incline.

As a check, energy conservation gives the same result: the block descends h = d sin(theta) = 0.9805 m, so (1/2) m v^2 = m g h and v = sqrt(2 g h) = sqrt(2 * 9.81 * 0.9805) = 4.39 m/s. The mass cancels, which is why the answer does not depend on 2.40 kg at all.

2. The same block is now given an initial speed of 3.00 m/s directed up the incline. How far along the slope does it travel before stopping?

The acceleration is unchanged in magnitude but now opposes the motion, so a = -5.199 m/s^2. Setting v = 0 in v^2 = v0^2 + 2 a d gives d = -v0^2 / (2a) = 9.00 / 10.398 = 0.866 m. The block then slides back down; because the surface is frictionless it returns to the starting point with speed 3.00 m/s, and the round trip takes t = 2 v0 / |a| = 6.00 / 5.199 = 1.15 s.

3. A uniform disk of mass M = 1.60 kg and radius R = 0.240 m rotates freely about a fixed horizontal axle through its centre. A light cord is wrapped around the rim and a 0.900 kg mass hangs from the free end. Find the angular acceleration of the disk.

The moment of inertia of a uniform disk about its centre is I = (1/2) M R^2 = 0.5 * 1.60 * 0.0576 = 0.04608 kg m^2. Let T be the cord tension. For the hanging mass, m g - T = m a. For the disk, T R = I alpha, and the cord does not slip, so a = alpha R.`;

/** One block whose text needs a character the reference hand refuses to fake. */
const MISSING_GLYPH_PROSE =
  'Angles are written out in words here because this hand cannot write θ or π, ' +
  'and substituting a Latin lookalike would change the answer.';

function makeDocument(): Document {
  return {
    id: 'harness',
    title: 'Problem Set 7',
    blocks: [
      { kind: 'prose', id: 'b0', seed: 20260917, text: PROSE },
      { kind: 'spacer', id: 'b1', seed: 3, height_mm: 6 },
      { kind: 'prose', id: 'b2', seed: 77, text: MISSING_GLYPH_PROSE },
    ],
  };
}

function makeStyle(neatness: number): Style {
  return {
    paper: { kind: 'ruled', ruling: 'college', page_size: 'letter', tint: '#F4F1E9' },
    hand: { profile: 'reference', size_mm: 4.2, slant_deg: -4, neatness, ink_colour: '#1B2A63' },
    preview_dpi: DPI,
  };
}

interface PageDom {
  readonly paper: HTMLCanvasElement;
  readonly ink: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
}

/**
 * Stand-in paper, because the paper strand has not landed. Flat tint plus the college
 * ruling at the SAME lattice layout snaps to (`textColumn().yMm + n * pitch`), so the
 * screenshot answers "does the writing sit on the lines" honestly rather than against
 * rules drawn wherever they happened to look good.
 */
function drawPaper(canvas: HTMLCanvasElement, style: Style): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('harness: no 2d context on the paper layer');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = style.paper?.tint ?? '#F4F1E9';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const marginTopMm = style.margins_mm?.[0] ?? 25.4;
  const marginLeftMm = style.margins_mm?.[3] ?? 31.75;
  const pitch = RULING.college.pitchMm;

  ctx.strokeStyle = '#B7C6D8';
  ctx.lineWidth = Math.max(1, mmToPx(0.12, DPI));
  for (let y = marginTopMm + pitch; y < PAGE.heightMm - 12; y += pitch) {
    ctx.beginPath();
    ctx.moveTo(0, mmToPx(y, DPI));
    ctx.lineTo(canvas.width, mmToPx(y, DPI));
    ctx.stroke();
  }
  ctx.strokeStyle = '#D9A2A2';
  ctx.beginPath();
  ctx.moveTo(mmToPx(marginLeftMm - 2.5, DPI), 0);
  ctx.lineTo(mmToPx(marginLeftMm - 2.5, DPI), canvas.height);
  ctx.stroke();
}

function makePage(host: HTMLElement, index: number): PageDom {
  const wrap = document.createElement('div');
  wrap.className = 'page';
  wrap.dataset['pageIndex'] = String(index);
  const make = (cls: string): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.className = `page-layer ${cls}`;
    c.width = Math.round(mmToPx(PAGE.widthMm, DPI));
    c.height = Math.round(mmToPx(PAGE.heightMm, DPI));
    return c;
  };
  const dom = { paper: make('paper'), ink: make('ink'), overlay: make('overlay') };
  wrap.append(dom.paper, dom.ink, dom.overlay);
  host.append(wrap);
  return dom;
}

export interface HarnessState {
  readonly geometry: DocumentGeometry;
  readonly pages: readonly PageDom[];
  readonly metrics: GlyphMetricsProvider;
  readonly outlines: GlyphOutlineProvider;
  readonly style: Style;
}

export interface Harness {
  /** Lay out and paint everything. Returns a summary for the driver to print. */
  render(neatness: number): Promise<Record<string, unknown>>;
  /** One full-page ink repaint, no dirty rect. Gate G3. */
  paintPage(pageIndex: number): void;
  /** One dirty-rect ink repaint over a block's box. Gate G1. */
  paintBlock(pageIndex: number, blockId: string): void;
  /** The dirty rect `paintBlock` would use, for the driver to report. */
  blockRect(pageIndex: number, blockId: string): RectMm | null;
  state(): HarnessState | null;
  /** Everything the driver needs to judge the page without reading pixels. */
  report(): Record<string, unknown>;
}

const engine = new OutlinePaintEngine();
let current: HarnessState | null = null;
let pageDom: PageDom[] = [];

function layersFor(pageIndex: number): {
  pageIndex: number;
  paper: HTMLCanvasElement;
  ink: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  dpi: number;
} {
  const dom = pageDom[pageIndex];
  if (!dom) throw new Error(`harness: no page ${pageIndex}`);
  return { pageIndex, paper: dom.paper, ink: dom.ink, overlay: dom.overlay, dpi: DPI };
}

function pageOf(pageIndex: number): PageGeometry {
  const page = current?.geometry.pages[pageIndex];
  if (!page) throw new Error(`harness: no geometry for page ${pageIndex}`);
  return page;
}

export const harness: Harness = {
  async render(neatness: number): Promise<Record<string, unknown>> {
    const host = document.getElementById('pages');
    if (!host) throw new Error('harness: no #pages host');
    host.replaceChildren();
    pageDom = [];

    const style = makeStyle(neatness);
    const hand = await glyphProfileProvider.load(style.hand?.profile ?? 'reference');
    const geometry = layoutEngine.layout(makeDocument(), style, hand.metrics);

    for (let i = 0; i < geometry.pages.length; i++) {
      const dom = makePage(host, i);
      pageDom.push(dom);
      drawPaper(dom.paper, style);
    }

    current = { geometry, pages: pageDom, metrics: hand.metrics, outlines: hand.outlines, style };

    for (const page of geometry.pages) {
      engine.paintInk(layersFor(page.pageIndex), page, style, hand.outlines);
    }
    return this.report();
  },

  paintPage(pageIndex: number): void {
    if (!current) throw new Error('harness: render() first');
    engine.paintInk(layersFor(pageIndex), pageOf(pageIndex), current.style, current.outlines);
  },

  paintBlock(pageIndex: number, blockId: string): void {
    if (!current) throw new Error('harness: render() first');
    const rect = this.blockRect(pageIndex, blockId);
    if (!rect) throw new Error(`harness: no block ${blockId} on page ${pageIndex}`);
    engine.paintInk(
      layersFor(pageIndex),
      pageOf(pageIndex),
      current.style,
      current.outlines,
      rect,
    );
  },

  blockRect(pageIndex: number, blockId: string): RectMm | null {
    const block = current?.geometry.pages[pageIndex]?.blocks.find((b) => b.blockId === blockId);
    return block ? block.boxMm : null;
  },

  state(): HarnessState | null {
    return current;
  },

  report(): Record<string, unknown> {
    if (!current) return { rendered: false };
    const pages = current.geometry.pages.map((p) => ({
      pageIndex: p.pageIndex,
      blocks: p.blocks.length,
      lines: p.blocks.reduce((n, b) => n + b.lines.length, 0),
      glyphs: p.blocks.reduce(
        (n, b) => n + b.lines.reduce((m, l) => m + l.glyphs.length, 0),
        0,
      ),
      problems: p.blocks.filter((b) => b.problem).map((b) => b.problem?.code),
    }));

    const first = current.geometry.pages[0]?.blocks[0]?.lines[0];
    const marginTopMm = 25.4;
    const pitch = RULING.college.pitchMm;
    const baselines = (current.geometry.pages[0]?.blocks[0]?.lines ?? [])
      .slice(0, 8)
      .map((l) => l.baselineYMm);

    return {
      rendered: true,
      profileId: current.outlines.profileId,
      unitsPerEm: current.outlines.unitsPerEm,
      styleHash: current.geometry.styleHash,
      pages,
      cacheEntries: engine.cache.size,
      cacheEstimatedBytes: engine.cache.estimatedBytes,
      firstBaselineMm: first?.baselineYMm ?? null,
      /** Where the harness drew its rules, so the driver can measure the offset. */
      rulesAtMm: [marginTopMm + pitch, marginTopMm + 2 * pitch, marginTopMm + 3 * pitch],
      baselinesMm: baselines,
      dpi: DPI,
      pageWidthPx: Math.round(mmToPx(PAGE.widthMm, DPI)),
      pageHeightPx: Math.round(mmToPx(PAGE.heightMm, DPI)),
    };
  },
};

(globalThis as Record<string, unknown>)['__harness'] = harness;

void harness.render(0.45).then((r) => {
  (globalThis as Record<string, unknown>)['__harnessReady'] = r;
});
