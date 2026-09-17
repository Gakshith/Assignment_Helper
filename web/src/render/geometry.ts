/**
 * The geometry contract. FROZEN with the seam-freeze commit.
 *
 * This is the boundary between layout and paint:
 *
 *     layout(document, style, metrics) -> DocumentGeometry     [deterministic, no canvas]
 *     paint(DocumentGeometry, style)  -> pixels                [canvas, no document semantics]
 *
 * Everything here is plain JSON-serialisable data with no methods and no canvas types,
 * because it is snapshot-goldened byte-for-byte (invariant I1) and because layout must
 * not be able to reach the canvas even by accident.
 *
 * Every coordinate is in MILLIMETRES of page space (invariant I8). There are no pixel
 * literals. Exactly one scale is applied at the canvas boundary, by paint, never here.
 */

import type { Mm, RectMm } from './units';

/**
 * One drawn glyph instance. This is where per-instance imperfection lives: the same
 * character at two places on the page has two different placements, and that is the
 * whole product.
 *
 * `variant` indexes a pre-perturbed outline of the same glyph. Under outline-first
 * (plan §C.1) there is no stroke, no pressure and no per-instance width — a variant is
 * a fixed affine perturbation of the outline, chosen by the counter-based RNG.
 */
export interface GlyphPlacement {
  /** The character. A single Unicode code point in v1 — no ligatures, no joins. */
  readonly ch: string;
  readonly xMm: Mm;
  /** Baseline y, already including this glyph's share of the drift. */
  readonly baselineYMm: Mm;
  readonly sizeMm: Mm;
  readonly rotDeg: number;
  readonly slantDeg: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly variant: number;
  /** Advance used by layout. Kept so paint never recomputes metrics and diverges. */
  readonly advanceMm: Mm;
}

export interface LineGeometry {
  readonly blockId: string;
  readonly lineIndex: number;
  /** The unjittered baseline. Per-glyph drift is already baked into each placement. */
  readonly baselineYMm: Mm;
  readonly xMm: Mm;
  readonly widthMm: Mm;
  readonly glyphs: readonly GlyphPlacement[];
}

/** A diagram primitive, already resolved to page coordinates. */
export interface FigureGeometry {
  readonly kind: 'line' | 'arrow' | 'circle' | 'rect' | 'label' | 'axis';
  readonly pointsMm: readonly (readonly [Mm, Mm])[];
  readonly label?: LineGeometry;
  readonly seed: string;
}

export interface BlockGeometry {
  readonly blockId: string;
  readonly kind: string;
  /** The block's bounding box. Used by the lasso spatial index and by dirty-rects. */
  readonly boxMm: RectMm;
  readonly pageIndex: number;
  readonly lines: readonly LineGeometry[];
  readonly figures: readonly FigureGeometry[];
  /**
   * Set when the block could not be laid out normally — an unparseable LaTeX source,
   * a token wider than the column, a glyph missing from the profile. Never silent
   * (invariant I5); the overlay layer draws a badge from this and, per §C.5.4, export
   * is BLOCKED while any block carries one.
   */
  readonly problem?: { readonly code: string; readonly message: string };
  /** True when the block was scaled down to fit (acceptance row 7), floor 0.70. */
  readonly fitScale: number;
}

export interface PageGeometry {
  readonly pageIndex: number;
  readonly widthMm: Mm;
  readonly heightMm: Mm;
  readonly blocks: readonly BlockGeometry[];
}

export interface DocumentGeometry {
  /** The document version this geometry was computed from. */
  readonly docVersion: number;
  /** Hash of the style that produced it. A style change invalidates every page. */
  readonly styleHash: string;
  readonly pages: readonly PageGeometry[];
}

/**
 * What layout needs from a hand, and all it needs. Deliberately free of Path2D and of
 * every other canvas type: layout must not be able to reach the canvas (plan §2).
 */
export interface GlyphMetricsProvider {
  readonly profileId: string;
  has(ch: string): boolean;
  /** Horizontal advance at the given nominal size. */
  advanceMm(ch: string, sizeMm: Mm): Mm;
  /** Distance above the baseline. Used for line packing and for box heights. */
  ascentMm(ch: string, sizeMm: Mm): Mm;
  descentMm(ch: string, sizeMm: Mm): Mm;
  variantCount(ch: string): number;
  /**
   * The documented nearest-shape substitution for a glyph the profile lacks
   * (acceptance row 5). Returns null when there is no sensible substitute, and the
   * caller must then raise a Problem — never render a blank, never render tofu.
   */
  substitute(ch: string): string | null;
}

/** What paint needs from a hand. Canvas-side twin of GlyphMetricsProvider. */
export interface GlyphOutlineProvider {
  readonly profileId: string;
  /**
   * The glyph outline as a path in a unit em box, y-up, origin at the baseline
   * origin. Returns null when absent — the caller raises a Problem (I5).
   */
  outline(ch: string, variant: number): Path2D | null;
  /** Units per em of the underlying outline source, so paint can scale exactly once. */
  readonly unitsPerEm: number;
}
