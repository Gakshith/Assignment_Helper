/**
 * PaperStyle (loose, optional, from the wire) -> PaperParams (total, validated).
 *
 * Everything downstream reads PaperParams, never PaperStyle, so the drawing pass has
 * no defaults of its own and no `?? something` scattered through it. The cache key and
 * the RNG seed are both derived from the SAME canonical string, which is how "same
 * style twice gives the same paper" is guaranteed rather than hoped for.
 */

import { fnv1a64 } from '../rng';
import { PAGE_SIZES, RULING, type Mm, type PageSizeName } from '../units';

export type PaperKind = 'ruled' | 'plain' | 'grid' | 'rough';
export type RulingName = keyof typeof RULING;

export interface PaperParams {
  readonly kind: PaperKind;
  readonly ruling: RulingName;
  readonly pageSize: PageSizeName;
  readonly widthMm: Mm;
  readonly heightMm: Mm;
  /** The base sheet colour. Always LIGHT — the page never inverts in dark mode. */
  readonly tint: string;
  readonly ruleColour: string;
  readonly marginRuleColour: string;
  readonly grain: number;
  readonly aging: number;
}

/**
 * Matches `--paper` in ui/app.css. Both the light and the dark palette there resolve
 * to a light sheet on purpose: dark mode themes the app chrome only. A photo-negative
 * page destroys the one thing this product sells, so there is no dark branch here at
 * all — not a conditional that happens to be false, simply no such code.
 */
export const DEFAULT_TINT = '#f4f1e9';
const DEFAULT_RULE_COLOUR = 'rgba(122,150,190,0.52)';
const DEFAULT_GRID_COLOUR = 'rgba(126,148,176,0.40)';
const DEFAULT_MARGIN_RULE_COLOUR = 'rgba(206,116,116,0.62)';
const DEFAULT_GRAIN = 0.46;
const DEFAULT_AGING = 0.12;

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;

/**
 * Canvas SILENTLY IGNORES an unparseable fillStyle — it keeps the previous colour and
 * draws something plausible-looking in the wrong shade. That is exactly the class of
 * failure invariant I5 exists to stop, so a bad colour is rejected here instead.
 */
function colour(field: string, value: string): string {
  if (HEX.test(value) || RGB.test(value)) return value;
  throw new Error(
    `paper: ${field} is not a colour Canvas2D will parse: ${JSON.stringify(value)}. ` +
      'Use #rgb, #rrggbb, rgb(r,g,b) or rgba(r,g,b,a).',
  );
}

/**
 * A 0..1 dial saturates at its ends — that is what a dial means. A NaN or an Infinity
 * is not an out-of-range dial, it is a bug upstream, and it throws.
 */
function dial(field: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`paper: ${field} must be a finite number in 0..1, got ${value}`);
  }
  return Math.min(1, Math.max(0, value));
}

/** Ruling only means something for ruled paper; grid always uses the 5 mm lattice. */
function defaultRuling(kind: PaperKind): RulingName {
  return kind === 'grid' ? 'grid5' : 'college';
}

export interface PaperStyleLike {
  readonly kind?: PaperKind;
  readonly ruling?: RulingName;
  readonly page_size?: PageSizeName;
  readonly tint?: string;
  readonly rule_colour?: string;
  readonly margin_rule_colour?: string;
  readonly grain?: number;
  readonly aging?: number;
}

export function resolveParams(style: PaperStyleLike | undefined): PaperParams {
  const kind = style?.kind ?? 'ruled';
  const ruling = style?.ruling ?? defaultRuling(kind);
  const pageSize = style?.page_size ?? 'letter';
  const size = PAGE_SIZES[pageSize];
  const ruleFallback = kind === 'grid' ? DEFAULT_GRID_COLOUR : DEFAULT_RULE_COLOUR;
  return {
    kind,
    ruling,
    pageSize,
    widthMm: size.widthMm,
    heightMm: size.heightMm,
    tint: colour('tint', style?.tint ?? DEFAULT_TINT),
    ruleColour: colour('rule_colour', style?.rule_colour ?? ruleFallback),
    marginRuleColour: colour(
      'margin_rule_colour',
      style?.margin_rule_colour ?? DEFAULT_MARGIN_RULE_COLOUR,
    ),
    grain: dial('grain', style?.grain ?? DEFAULT_GRAIN),
    aging: dial('aging', style?.aging ?? DEFAULT_AGING),
  };
}

/**
 * The tint, if it is usable, without throwing. The I6 fallback needs a colour at the
 * exact moment something has already gone wrong — possibly the tint itself — so this
 * one path answers with `null` rather than raising. It is the only such path.
 */
export function safeTint(style: PaperStyleLike | undefined): string | null {
  const t = style?.tint;
  if (t === undefined) return DEFAULT_TINT;
  return HEX.test(t) || RGB.test(t) ? t : null;
}

/** Canonical, order-stable, every field present. The seed and the cache key share it. */
export function paramsKey(p: PaperParams): string {
  return [
    p.kind,
    p.ruling,
    p.pageSize,
    p.tint,
    p.ruleColour,
    p.marginRuleColour,
    p.grain.toFixed(4),
    p.aging.toFixed(4),
  ].join('|');
}

/**
 * The sheet's seed. Deliberately NOT a function of DPI.
 *
 * The grain cell is specified in millimetres, so the speckle is already
 * resolution-independent; folding DPI into the seed would only mean the 300 DPI export
 * showed a DIFFERENT sheet of paper from the 150 DPI preview the user approved. The
 * cache key still carries DPI — two rasters, one sheet.
 */
export function seedOf(p: PaperParams): bigint {
  return fnv1a64(`paper:${paramsKey(p)}`);
}

export function cacheKey(p: PaperParams, dpi: number): string {
  return `${paramsKey(p)}|dpi=${dpi}|seed=${seedOf(p).toString(16)}`;
}
