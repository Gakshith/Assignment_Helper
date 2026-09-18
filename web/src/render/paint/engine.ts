/**
 * The paint engine. Draws exactly what the geometry says, and nothing it decided itself.
 *
 * The one-line summary of this whole strand: layout already rolled every die. Position,
 * baseline drift, slant, rotation, per-instance scale, which of the six variants — all of
 * it is sitting in the `GlyphPlacement`, goldened, reproducible. Paint builds a matrix
 * from those six numbers, fills a cached outline, and stops. Every extra wobble added
 * here would be a second, ungoldened imperfection model applied on top of the first, and
 * the symptom is a preview that does not match its own export.
 */

import type { PageLayers, PaintEngine, Style } from '../../app/contracts';
import type { GlyphOutlineProvider, GlyphPlacement, PageGeometry } from '../geometry';
import { mmToPx, rectExpand, rectIntersects, type Mm, type RectMm } from '../units';
import { OutlineCache } from './cache';
import { DEFAULT_INK, INK_KERNEL_RADIUS_MM, inkFor } from './ink';
import { emToDeviceMatrix, placementBoundsMm, placementMatrix } from './transform';

/**
 * Mirrors the schema default in layout/style.ts. Every `Style` field is optional because
 * Pydantic's defaults do not survive the trip through JSON Schema, so both strands have
 * to restate them — and they must not drift, or preview and layout disagree about how
 * neat the hand is.
 */
const DEFAULT_NEATNESS = 0.5;

/**
 * Quantisation of the em -> device scale, in 1/256ths of a device pixel per em.
 *
 * It exists so that float noise in `sizeMm * dpi / 25.4` cannot mint a fresh cache entry
 * for a scale the eye cannot tell from one already held. At a 4.2 mm hand and 150 dpi an
 * em is about 25 px, so one step is 1/256 px across a whole em — four orders of magnitude
 * below a pixel. The QUANTISED value is what builds the path, not just what keys it;
 * keying on a rounded number and drawing with an unrounded one would hand the second
 * caller the first caller's outline.
 */
const SCALE_QUANT = 256;

/**
 * Slack on the line-level horizontal cull. A glyph's left side bearing and its slant both
 * put ink outside `[xMm, xMm + widthMm]`, and the per-glyph test is what is precise —
 * this one only has to avoid being wrong.
 */
const LINE_X_PAD_MM: Mm = 6;

/** One character the hand could not draw. Accumulated, then thrown. See {@link PaintOutlineError}. */
export interface MissingOutline {
  readonly ch: string;
  readonly variant: number;
  readonly count: number;
}

/**
 * ------------------------------------------------------------------------------------
 * INVARIANT I5, AND THE SEAM THIS RUNS INTO. Read this before "fixing" the throw.
 *
 * I5 says a missing outline is a Problem, not a skipped character, and that the kernel's
 * problem sink is the only error path. Paint agrees with both halves and CANNOT OBEY THE
 * SECOND ONE: `PaintEngine.paintInk(layers, page, style, outlines, dirtyMm?)` is frozen in
 * app/contracts.ts and is handed no `ProblemSink`, no return value and no callback.
 * `PageLayers` has no sink on it either, and `Style` is plain document data. There is no
 * legal route from here to the sink. Reaching the kernel through a global would be the
 * "second error path" I5 forbids in the same breath.
 *
 * So this is reported as a contract bug rather than worked around, and in the meantime
 * the failure is made as loud as the seam allows: every glyph that CAN be drawn is drawn
 * first, the misses are collected with their counts, and one `PaintOutlineError` carrying
 * the whole list is thrown at the end. The kernel calls `paintInk` unguarded inside a
 * requestAnimationFrame callback, so the throw surfaces as an uncaught error with the
 * characters named. Loud and incomplete beats quiet and plausible.
 *
 * Note that layout makes this unreachable for a consistent hand: text.ts only emits a
 * placement for a character `metrics.has()` accepted, and both providers are built over
 * one parsed font (glyphs/provider.ts). Reaching this code means metrics and outlines
 * have come from two different readings of a font, which is the exact bug that pairing
 * them was meant to prevent.
 * ------------------------------------------------------------------------------------
 */
export class PaintOutlineError extends Error {
  readonly missing: readonly MissingOutline[];

  constructor(profileId: string, missing: readonly MissingOutline[]) {
    const names = missing
      .map((m) => `${JSON.stringify(m.ch)} (variant ${m.variant}, x${m.count})`)
      .join(', ');
    super(
      `the hand "${profileId}" returned no outline for ${missing.length} character(s): ` +
        `${names}. Layout placed them, so its metrics provider claims the hand HAS them; ` +
        `metrics and outlines have diverged.`,
    );
    this.name = 'PaintOutlineError';
    this.missing = missing;
  }
}

function neatnessOf(style: Style): number {
  const n = style.hand?.neatness;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_NEATNESS;
  return Math.min(1, Math.max(0, n));
}

export class OutlinePaintEngine implements PaintEngine {
  readonly name = 'outline-paint';

  readonly cache: OutlineCache;

  constructor(cache: OutlineCache = new OutlineCache()) {
    this.cache = cache;
  }

  paintInk(
    layers: PageLayers,
    page: PageGeometry,
    style: Style,
    outlines: GlyphOutlineProvider,
    dirtyMm?: RectMm,
  ): void {
    const ctx = layers.ink.getContext('2d');
    // I5: a page with no context is not a page that renders nothing, it is a broken app.
    if (!ctx) throw new Error('outline-paint: no 2d context on the ink layer');

    const dpi = layers.dpi;
    const upem = outlines.unitsPerEm;
    if (!Number.isFinite(upem) || upem <= 0) {
      throw new Error(`outline-paint: the hand reports unitsPerEm=${upem}; it cannot be scaled`);
    }

    /**
     * I7. The clip is the dirty rect grown by the ink kernel, because the weight stroke
     * puts ink up to half a line width outside the geometric outline and a rectangle
     * cleared to the exact bound would leave a hairline of the previous frame behind.
     */
    const clipMm: RectMm = dirtyMm
      ? rectExpand(dirtyMm, INK_KERNEL_RADIUS_MM)
      : { xMm: 0, yMm: 0, wMm: page.widthMm, hMm: page.heightMm };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;

    if (dirtyMm) {
      const x = mmToPx(clipMm.xMm, dpi);
      const y = mmToPx(clipMm.yMm, dpi);
      const w = mmToPx(clipMm.wMm, dpi);
      const h = mmToPx(clipMm.hMm, dpi);
      ctx.clearRect(x, y, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    } else {
      // The backing store, not a geometry literal: the kernel rounds the page size to
      // whole device pixels when it sizes the canvas, and anything left outside that
      // rounding is stale ink.
      ctx.clearRect(0, 0, layers.ink.width, layers.ink.height);
      ctx.save();
    }

    const inkColour = style.hand?.ink_colour ?? DEFAULT_INK;
    ctx.fillStyle = inkColour;
    ctx.strokeStyle = inkColour;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const imperfection = 1 - neatnessOf(style);
    const missing = new Map<string, MissingOutline>();

    try {
      for (const block of page.blocks) {
        // The coarse cull, and the one that does the work: the scheduler invalidates
        // BLOCKS, so a single-block repaint discards every other block here in O(blocks).
        if (!rectIntersects(block.boxMm, clipMm)) continue;

        for (const line of block.lines) {
          if (line.glyphs.length === 0) continue;
          // Horizontal cull only. `xMm` and `widthMm` are exact, but a line carries no
          // height — per-glyph sizes within one line differ — so the vertical test waits
          // for the per-glyph bound below.
          const lineSpan: RectMm = {
            xMm: line.xMm - LINE_X_PAD_MM,
            yMm: clipMm.yMm,
            wMm: line.widthMm + 2 * LINE_X_PAD_MM,
            hMm: clipMm.hMm,
          };
          if (!rectIntersects(lineSpan, clipMm)) continue;

          for (const g of line.glyphs) {
            if (!rectIntersects(placementBoundsMm(g, INK_KERNEL_RADIUS_MM), clipMm)) continue;
            this.#drawGlyph(ctx, g, outlines, upem, dpi, imperfection, missing);
          }
        }
      }
    } finally {
      // Restore before anything can escape, so a throw does not leave the next subsystem
      // painting through this page's clip. figures/index.ts shares this canvas stack.
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }

    if (missing.size > 0) {
      throw new PaintOutlineError(outlines.profileId, [...missing.values()]);
    }
  }

  #drawGlyph(
    ctx: CanvasRenderingContext2D,
    g: GlyphPlacement,
    outlines: GlyphOutlineProvider,
    upem: number,
    dpi: number,
    imperfection: number,
    missing: Map<string, MissingOutline>,
  ): void {
    // Quantise the scale, then use the quantised value for BOTH the key and the matrix.
    const scaleKey = Math.round(mmToPx(g.sizeMm, dpi) * SCALE_QUANT);
    const key = OutlineCache.key(outlines.profileId, g.ch, g.variant, scaleKey);

    let path = this.cache.get(key);
    if (path === undefined) {
      const source = outlines.outline(g.ch, g.variant);
      if (source === null) {
        const mkey = `${g.ch} ${g.variant}`;
        const seen = missing.get(mkey);
        missing.set(mkey, {
          ch: g.ch,
          variant: g.variant,
          count: (seen?.count ?? 0) + 1,
        });
        return;
      }
      // One `addPath` per (character, variant, scale). Never per instance: that would be
      // a re-tessellation in the hot loop, which is exactly what I7 rules out.
      path = new Path2D();
      path.addPath(source, emToDeviceMatrix(scaleKey / SCALE_QUANT, upem));
      this.cache.set(key, path);
    }

    const m = placementMatrix(g, dpi);
    const ink = inkFor(g, imperfection);

    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.globalAlpha = ink.alpha;
    ctx.fill(path);

    if (ink.weightMm > 0) {
      // `lineWidth` is in the current user space, whose scale is the per-instance
      // scaleX/scaleY — within 14% of 1 by construction (params.ts caps the per-instance
      // scale variation). Treating it as 1 costs at most 0.004 mm of stroke width, which
      // is a fiftieth of a device pixel at preview DPI.
      ctx.lineWidth = mmToPx(ink.weightMm, dpi);
      ctx.stroke(path);
    }
  }
}
