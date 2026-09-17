/**
 * Millimetres of page space. Invariant I8.
 *
 * There are no pixel literals in the render path. Every geometry, amplitude,
 * radius and frequency is in mm; exactly one scale is applied at the canvas
 * boundary. Without this, preview and export diverge and G16 catches it late.
 *
 * Leaf module: zero imports, by design (plan §2 module table).
 */

export type Mm = number;

export const MM_PER_INCH = 25.4;

/** The one conversion. Applied at the canvas boundary and nowhere else. */
export function mmToPx(mm: Mm, dpi: number): number {
  return (mm / MM_PER_INCH) * dpi;
}

export function pxToMm(px: number, dpi: number): Mm {
  return (px / dpi) * MM_PER_INCH;
}

export function ptToMm(pt: number): Mm {
  return (pt / 72) * MM_PER_INCH;
}

export interface PageSize {
  readonly name: string;
  readonly widthMm: Mm;
  readonly heightMm: Mm;
}

export const PAGE_SIZES = {
  letter: { name: 'letter', widthMm: 215.9, heightMm: 279.4 },
  a4: { name: 'a4', widthMm: 210, heightMm: 297 },
  legal: { name: 'legal', widthMm: 215.9, heightMm: 355.6 },
} as const satisfies Record<string, PageSize>;

export type PageSizeName = keyof typeof PAGE_SIZES;

export interface Margins {
  readonly topMm: Mm;
  readonly rightMm: Mm;
  readonly bottomMm: Mm;
  readonly leftMm: Mm;
}

export interface RectMm {
  readonly xMm: Mm;
  readonly yMm: Mm;
  readonly wMm: Mm;
  readonly hMm: Mm;
}

export function textColumn(size: PageSize, m: Margins): RectMm {
  return {
    xMm: m.leftMm,
    yMm: m.topMm,
    wMm: size.widthMm - m.leftMm - m.rightMm,
    hMm: size.heightMm - m.topMm - m.bottomMm,
  };
}

export function rectIntersects(a: RectMm, b: RectMm): boolean {
  return (
    a.xMm < b.xMm + b.wMm &&
    b.xMm < a.xMm + a.wMm &&
    a.yMm < b.yMm + b.hMm &&
    b.yMm < a.yMm + a.hMm
  );
}

/** Union of two rects. The dirty-rect accumulator's only primitive. */
export function rectUnion(a: RectMm, b: RectMm): RectMm {
  const x = Math.min(a.xMm, b.xMm);
  const y = Math.min(a.yMm, b.yMm);
  return {
    xMm: x,
    yMm: y,
    wMm: Math.max(a.xMm + a.wMm, b.xMm + b.wMm) - x,
    hMm: Math.max(a.yMm + a.hMm, b.yMm + b.hMm) - y,
  };
}

/** Expand by the kernel radius before an ink post-pass. Invariant I7. */
export function rectExpand(r: RectMm, byMm: Mm): RectMm {
  return { xMm: r.xMm - byMm, yMm: r.yMm - byMm, wMm: r.wMm + 2 * byMm, hMm: r.hMm + 2 * byMm };
}

/** College-ruled spacing, measured from real paper. Used by render/paper. */
export const RULING = {
  college: { pitchMm: 7.1, marginFromLeftMm: 31.75 },
  wide: { pitchMm: 8.7, marginFromLeftMm: 31.75 },
  grid5: { pitchMm: 5, marginFromLeftMm: 0 },
} as const;
