/**
 * The parsed hand, wrapped so nothing downstream ever sees an opentype.js type.
 *
 * ONE PARSE, TWO PROVIDERS. Layout's `GlyphMetricsProvider` and paint's
 * `GlyphOutlineProvider` are both built from the object this module returns, so an
 * advance layout used and an outline paint drew can never come from two different
 * readings of the font. That is the whole reason this file exists rather than each
 * provider parsing for itself.
 *
 * COORDINATE CONVENTION. opentype.js hands back `getPath()` coordinates with y pointing
 * DOWN (it has already flipped the font's native y-up space for canvas). The geometry
 * contract says the outline provider must expose "a path in a unit em box, y-up, origin
 * at the baseline origin", so this module flips it back exactly once, here. Everything
 * above `font.ts` in this strand is y-UP font units; the single flip back to screen
 * space happens in the paint strand, at the canvas boundary.
 *
 * This file has no canvas types. It is imported by the metrics provider, which layout
 * uses, and layout must not be able to reach the canvas even by accident (plan §2).
 */

import { parse, type PathCommand } from 'opentype.js/dist/opentype.mjs';

/** One outline command in y-UP font units. A flipped, narrowed `PathCommand`. */
export type OutlineCommand =
  | { readonly op: 'M'; readonly x: number; readonly y: number }
  | { readonly op: 'L'; readonly x: number; readonly y: number }
  | {
      readonly op: 'Q';
      readonly x1: number;
      readonly y1: number;
      readonly x: number;
      readonly y: number;
    }
  | {
      readonly op: 'C';
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly op: 'Z' };

/** The vertical extent of one glyph's ink, in y-UP font units. */
export interface GlyphExtent {
  /** Highest ink above the baseline. 0 for a glyph with no contours, never -Infinity. */
  readonly yMax: number;
  /** Lowest ink, negative below the baseline. 0 for a glyph with no contours. */
  readonly yMin: number;
}

export interface GlyphRecord {
  readonly glyphId: number;
  readonly advanceWidth: number;
  /** Empty for a glyph that exists but draws nothing, such as the space. */
  readonly commands: readonly OutlineCommand[];
  readonly extent: GlyphExtent;
}

export interface ParsedHand {
  readonly unitsPerEm: number;
  /** Font-wide ascender, y-up font units. Used only as a floor for empty glyphs. */
  readonly ascender: number;
  /** Font-wide descender, NEGATIVE, y-up font units. */
  readonly descender: number;
  readonly glyphCount: number;
  has(ch: string): boolean;
  /** Null when the font has no glyph for `ch`. Memoised; never re-reads the font. */
  glyph(ch: string): GlyphRecord | null;
}

/**
 * A character the font maps to glyph 0. opentype.js resolves an unmapped character to
 * `.notdef` rather than failing, so the glyph index is the only reliable "absent" signal
 * — and drawing `.notdef` is exactly the tofu the contract forbids (acceptance row 5).
 */
const NOTDEF_GLYPH_ID = 0;

function flip(commands: readonly PathCommand[]): OutlineCommand[] {
  const out: OutlineCommand[] = [];
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        out.push({ op: 'M', x: c.x, y: -c.y });
        break;
      case 'L':
        out.push({ op: 'L', x: c.x, y: -c.y });
        break;
      case 'Q':
        out.push({ op: 'Q', x1: c.x1, y1: -c.y1, x: c.x, y: -c.y });
        break;
      case 'C':
        out.push({ op: 'C', x1: c.x1, y1: -c.y1, x2: c.x2, y2: -c.y2, x: c.x, y: -c.y });
        break;
      case 'Z':
        out.push({ op: 'Z' });
        break;
    }
  }
  return out;
}

/**
 * The extent over the CONTROL POINTS, not over the true curve.
 *
 * A quadratic or cubic Bezier is contained in the convex hull of its control points, so
 * this is always a superset of the real ink. Being generous is the safe direction: the
 * layout strand turns this into the block bounding box that the lasso index and the
 * dirty-rect cull both trust, and a box that is too tight drops ink the user can see
 * while a box that is a few font units too tall costs nothing.
 */
function extentOf(commands: readonly OutlineCommand[]): GlyphExtent {
  let yMax = -Infinity;
  let yMin = Infinity;
  const see = (y: number): void => {
    if (y > yMax) yMax = y;
    if (y < yMin) yMin = y;
  };
  for (const c of commands) {
    switch (c.op) {
      case 'M':
      case 'L':
        see(c.y);
        break;
      case 'Q':
        see(c.y1);
        see(c.y);
        break;
      case 'C':
        see(c.y1);
        see(c.y2);
        see(c.y);
        break;
      case 'Z':
        break;
    }
  }
  if (!Number.isFinite(yMax) || !Number.isFinite(yMin)) return { yMax: 0, yMin: 0 };
  // A glyph entirely above the baseline still has a descent of zero, not a positive one.
  return { yMax: Math.max(0, yMax), yMin: Math.min(0, yMin) };
}

/**
 * Parse a font file into the one reading of it that both providers share.
 *
 * Throws on a font that cannot be used at all — a zero `unitsPerEm` would silently turn
 * every advance into Infinity and every glyph into a dot, which is precisely the kind of
 * failure invariant I5 exists to make loud.
 */
export function parseHand(data: ArrayBuffer): ParsedHand {
  const font = parse(data);

  const unitsPerEm = font.unitsPerEm;
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) {
    throw new Error(`the reference hand reports unitsPerEm=${unitsPerEm}; it cannot be scaled`);
  }
  if (font.numGlyphs <= 1) {
    throw new Error(`the reference hand contains ${font.numGlyphs} glyph(s); it has no letters`);
  }

  const cache = new Map<string, GlyphRecord | null>();

  const glyph = (ch: string): GlyphRecord | null => {
    const hit = cache.get(ch);
    if (hit !== undefined) return hit;

    let record: GlyphRecord | null = null;
    if (font.hasChar(ch)) {
      const g = font.charToGlyph(ch);
      if (g.index !== NOTDEF_GLYPH_ID) {
        const commands = flip(g.getPath(0, 0, unitsPerEm).commands);
        const advance = g.advanceWidth;
        record = {
          glyphId: g.index,
          // A missing advanceWidth is a malformed hmtx entry. Fall back to the em rather
          // than to NaN: layout's resolveText() treats a non-finite advance as a
          // `layout.bad-metrics` problem, and a whole page of badges for one bad entry
          // buries the signal. The over-wide advance is visible on its own.
          advanceWidth: Number.isFinite(advance) && advance !== undefined ? advance : unitsPerEm,
          commands,
          extent: extentOf(commands),
        };
      }
    }
    cache.set(ch, record);
    return record;
  };

  return {
    unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    glyphCount: font.numGlyphs,
    has: (ch) => glyph(ch) !== null,
    glyph,
  };
}
