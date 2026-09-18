/**
 * A fully resolved Style, and the conversion back to the wire.
 *
 * WHY RESOLVED AND NOT PARTIAL. `POST /api/document/style` is sugar over a one-op
 * delta, and `SetStyle` in assignment_helper/document/ops.py does `style = op.style`
 * -- a whole-object REPLACE, not a merge. `Style` is a pydantic model with
 * `extra="forbid"` and a default for every field, so posting only the field that
 * changed does not leave the rest alone: it silently resets them to schema defaults.
 * Change the ink colour with a partial body and the user's page size goes back to
 * letter. So the panel holds a complete style, edits one field of it, and posts the
 * whole thing.
 *
 * The `??` defaults below are the schema's own documented defaults for an absent
 * optional field, read straight out of assignment_helper/document/schema.py. They
 * are not standing in for a failed call: a failed call throws in style-client.ts and
 * is never resolved into a document here (invariant I5).
 */

import type { Style } from '../../types/document';

export type PaperKind = 'ruled' | 'plain' | 'grid' | 'rough';
export type Ruling = 'college' | 'wide' | 'grid5';
export type PageSize = 'letter' | 'a4' | 'legal';

export interface ResolvedPaper {
  readonly kind: PaperKind;
  readonly ruling: Ruling;
  readonly page_size: PageSize;
  readonly tint: string;
  readonly rule_colour: string;
  readonly margin_rule_colour: string;
  readonly grain: number;
  readonly aging: number;
}

export interface ResolvedHand {
  readonly profile: string;
  readonly ink_colour: string;
  readonly size_mm: number;
  readonly slant_deg: number;
  readonly neatness: number;
  readonly overrides: Readonly<Record<string, number>>;
}

export interface ResolvedStyle {
  readonly paper: ResolvedPaper;
  readonly hand: ResolvedHand;
  readonly margins_mm: readonly [number, number, number, number];
  readonly preview_dpi: number;
  readonly export_dpi: number;
}

/** Mirrors assignment_helper/document/schema.py. A drift here is a visible bug. */
export const DEFAULT_STYLE: ResolvedStyle = {
  paper: {
    kind: 'ruled',
    ruling: 'college',
    page_size: 'letter',
    tint: '#F4F1E9',
    rule_colour: '#9FB6CC',
    margin_rule_colour: '#D08C8C',
    grain: 0.5,
    aging: 0.15,
  },
  hand: {
    profile: 'reference',
    ink_colour: '#1C2521',
    size_mm: 4.2,
    slant_deg: -4.0,
    neatness: 0.5,
    overrides: {},
  },
  margins_mm: [25.4, 19.0, 25.4, 31.75],
  preview_dpi: 150,
  export_dpi: 200,
};

export const PAPER_KINDS: readonly PaperKind[] = ['ruled', 'plain', 'grid', 'rough'];
export const RULINGS: readonly Ruling[] = ['college', 'wide', 'grid5'];
export const PAGE_SIZES_UI: readonly PageSize[] = ['letter', 'a4', 'legal'];

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function margins(value: Style['margins_mm']): readonly [number, number, number, number] {
  if (!value) return DEFAULT_STYLE.margins_mm;
  const [top, right, bottom, left] = value;
  return [
    numberOr(top, DEFAULT_STYLE.margins_mm[0]),
    numberOr(right, DEFAULT_STYLE.margins_mm[1]),
    numberOr(bottom, DEFAULT_STYLE.margins_mm[2]),
    numberOr(left, DEFAULT_STYLE.margins_mm[3]),
  ];
}

function overridesOf(raw: Readonly<Record<string, number>> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

export function resolveStyle(style: Style | undefined): ResolvedStyle {
  const paper = style?.paper;
  const hand = style?.hand;
  const d = DEFAULT_STYLE;
  return {
    paper: {
      kind: paper?.kind ?? d.paper.kind,
      ruling: paper?.ruling ?? d.paper.ruling,
      page_size: paper?.page_size ?? d.paper.page_size,
      tint: paper?.tint ?? d.paper.tint,
      rule_colour: paper?.rule_colour ?? d.paper.rule_colour,
      margin_rule_colour: paper?.margin_rule_colour ?? d.paper.margin_rule_colour,
      grain: numberOr(paper?.grain, d.paper.grain),
      aging: numberOr(paper?.aging, d.paper.aging),
    },
    hand: {
      profile: hand?.profile ?? d.hand.profile,
      ink_colour: hand?.ink_colour ?? d.hand.ink_colour,
      size_mm: numberOr(hand?.size_mm, d.hand.size_mm),
      slant_deg: numberOr(hand?.slant_deg, d.hand.slant_deg),
      neatness: numberOr(hand?.neatness, d.hand.neatness),
      overrides: overridesOf(hand?.overrides),
    },
    margins_mm: margins(style?.margins_mm),
    preview_dpi: numberOr(style?.preview_dpi, d.preview_dpi),
    export_dpi: numberOr(style?.export_dpi, d.export_dpi),
  };
}

/** The complete body for POST /api/document/style. Every field, every time. */
export function toWire(style: ResolvedStyle): Style {
  const [top, right, bottom, left] = style.margins_mm;
  return {
    paper: { ...style.paper },
    hand: { ...style.hand, overrides: { ...style.hand.overrides } },
    margins_mm: [top, right, bottom, left],
    preview_dpi: style.preview_dpi,
    export_dpi: style.export_dpi,
  };
}

export function withPaper(style: ResolvedStyle, patch: Partial<ResolvedPaper>): ResolvedStyle {
  return { ...style, paper: { ...style.paper, ...patch } };
}

export function withHand(style: ResolvedStyle, patch: Partial<ResolvedHand>): ResolvedStyle {
  return { ...style, hand: { ...style.hand, ...patch } };
}

export function sameStyle(a: ResolvedStyle, b: ResolvedStyle): boolean {
  return JSON.stringify(toWire(a)) === JSON.stringify(toWire(b));
}
