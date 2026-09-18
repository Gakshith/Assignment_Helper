/**
 * The KaTeX box-tree walk. Milestone M3.
 *
 * This was the project's #1 risk — "hand-drawn math layout has no off-the-shelf
 * solution" — and it was retired by spike rather than by argument. KaTeX's private
 * `__renderToDomTree` returns a fully positioned box tree carrying real TeX metrics,
 * so the job is reading a tree, not reimplementing TeXbook Appendix G.
 *
 * Verified against katex 0.16.11 on 2026-09-17 and pinned by
 * `tests/unit/katex.contract.test.ts`, because all three entry points are
 * underscore-private and a patch release can remove them with no semver signal.
 *
 * ## What the tree actually gives us
 *
 * - **Horizontal**: symbol nodes carry `width` in em. Inter-atom TeX spacing arrives
 *   as `mspace` nodes with `style.marginRight` in em — spacing is IN THE TREE, as data,
 *   not as CSS we would have to reimplement. That single fact is what makes this a walk.
 * - **Vertical**: a `vlist` stacks rows, each with `style.top` in em against a `pstrut`
 *   of known height. A row's baseline shift is `pstrutHeight + top`, positive meaning
 *   below the baseline. For display `\frac{a}{b}`: numerator −0.677em, denominator
 *   +0.686em, and the root box's own depth is 0.686em — they agree exactly.
 *
 * ## The finding that shapes the design
 *
 * `__setFontMetrics` must be applied **per font family**. Substituting `Main-Regular`
 * alone does not move `\frac{a}{b}` at all, because `a` and `b` are typeset in
 * `Math-Italic`; the root height stays at 1.10756. Substituting `Math-Italic` moves it
 * to 2.69. A single global substitution silently does nothing to exactly the glyphs
 * that carry the most meaning — and it fails *silently*: the page renders, looks
 * plausible, and is spaced wrong.
 */

import type { GlyphMetricsProvider, GlyphPlacement } from '../geometry';
import type { Mm } from '../units';

/** Every family KaTeX may reach for in the subset we support. */
export const FONT_FAMILIES = [
  'Main-Regular',
  'Main-Bold',
  'Main-Italic',
  'Math-Italic',
  'Size1-Regular',
  'Size2-Regular',
  'Size3-Regular',
  'Size4-Regular',
  'AMS-Regular',
] as const;

export type FontFamily = (typeof FONT_FAMILIES)[number];

/** KaTeX class -> font family. Order matters: the most specific class wins. */
export function familyFor(classes: readonly string[]): FontFamily {
  if (classes.includes('mathnormal') || classes.includes('mathit')) return 'Math-Italic';
  if (classes.includes('mathbf') || classes.includes('textbf')) return 'Main-Bold';
  if (classes.includes('textit')) return 'Main-Italic';
  if (classes.includes('size1')) return 'Size1-Regular';
  if (classes.includes('size2')) return 'Size2-Regular';
  if (classes.includes('size3')) return 'Size3-Regular';
  if (classes.includes('size4')) return 'Size4-Regular';
  if (classes.includes('amsrm')) return 'AMS-Regular';
  return 'Main-Regular';
}

interface KatexNode {
  readonly classes?: string[];
  readonly children?: KatexNode[];
  readonly text?: string;
  readonly height?: number;
  readonly depth?: number;
  readonly width?: number;
  readonly italic?: number;
  readonly skew?: number;
  readonly maxFontSize?: number;
  readonly style?: Record<string, string>;
}

function em(value: string | undefined): number {
  if (!value) return 0;
  const n = Number.parseFloat(value.replace('em', ''));
  return Number.isFinite(n) ? n : 0;
}

export interface MathWalkResult {
  readonly glyphs: readonly Omit<GlyphPlacement, 'variant'>[];
  /** Total advance, in em. The caller scales by the nominal size. */
  readonly widthEm: number;
  readonly heightEm: number;
  readonly depthEm: number;
}

interface Cursor {
  xEm: number;
  yEm: number;
  scale: number;
}

/**
 * Walk a KaTeX box tree into positioned glyphs. Pure: no canvas, no DOM reads, no
 * randomness — invariant I1 applies here as much as anywhere under `render/`.
 */
export function walkTree(root: KatexNode): MathWalkResult {
  const glyphs: Omit<GlyphPlacement, 'variant'>[] = [];
  const cursor: Cursor = { xEm: 0, yEm: 0, scale: 1 };
  let maxX = 0;

  const visit = (node: KatexNode, yEm: number, scale: number): void => {
    const classes = node.classes ?? [];

    // A strut reserves height and draws nothing. Skipping it is not an omission.
    if (classes.includes('strut') || classes.includes('pstrut')) return;

    // The MathML mirror duplicates every symbol for screen readers. Walking it would
    // render the whole expression twice, invisibly offset.
    if (classes.includes('katex-mathml')) return;

    if (classes.includes('vlist')) {
      for (const row of node.children ?? []) {
        // Each row's own `top`, measured against the pstrut inside it.
        const top = em(row.style?.['top']);
        const pstrut = (row.children ?? []).find((c) => (c.classes ?? []).includes('pstrut'));
        const pstrutH = em(pstrut?.style?.['height']);
        // Positive = below the baseline, matching screen coordinates.
        const shift = pstrutH + top;
        const rowX = cursor.xEm;
        for (const child of row.children ?? []) visit(child, yEm + shift, scale);
        // vlist rows stack vertically, so each starts at the same x.
        cursor.xEm = rowX;
      }
      // The vlist as a whole advances by its widest row.
      cursor.xEm = Math.max(cursor.xEm, maxX);
      return;
    }

    // A fraction bar is a rule, not a glyph. Emitted as a zero-height box the paint
    // engine draws as a stroke; represented here as a placement so it participates in
    // the same transform pipeline as everything else.
    if (classes.includes('frac-line')) {
      const width = node.width ?? 0;
      glyphs.push({
        ch: '─', // BOX DRAWINGS LIGHT HORIZONTAL — the rule
        xMm: cursor.xEm,
        baselineYMm: yEm,
        sizeMm: scale,
        rotDeg: 0,
        slantDeg: 0,
        scaleX: width,
        scaleY: em(node.style?.['borderBottomWidth']) || 0.04,
        advanceMm: width,
      });
      return;
    }

    if (classes.includes('mspace')) {
      // TeX inter-atom spacing, as DATA in em. This is the thing that makes the whole
      // approach work: we read the number instead of reimplementing the rules.
      cursor.xEm += em(node.style?.['marginRight']);
      return;
    }

    if (typeof node.text === 'string' && node.text.length > 0 && !node.children?.length) {
      const family = familyFor(classes);
      const width = node.width ?? 0;
      for (const ch of node.text) {
        glyphs.push({
          ch,
          xMm: cursor.xEm,
          baselineYMm: yEm,
          sizeMm: scale,
          rotDeg: 0,
          slantDeg: family.includes('Italic') ? -12 : 0,
          scaleX: 1,
          scaleY: 1,
          advanceMm: width,
        });
        cursor.xEm += width;
        maxX = Math.max(maxX, cursor.xEm);
      }
      return;
    }

    const marginLeft = em(node.style?.['marginLeft']);
    if (marginLeft) cursor.xEm += marginLeft;

    for (const child of node.children ?? []) visit(child, yEm, scale);

    const marginRight = em(node.style?.['marginRight']);
    if (marginRight) cursor.xEm += marginRight;
    maxX = Math.max(maxX, cursor.xEm);
  };

  visit(root, 0, 1);

  return {
    glyphs,
    widthEm: Math.max(maxX, cursor.xEm),
    heightEm: root.height ?? 0,
    depthEm: root.depth ?? 0,
  };
}

/**
 * Feed the user's hand's metrics into KaTeX, per family.
 *
 * KaTeX's metric rows are `[depth, height, italic, skew, width]` in em, keyed by code
 * point. Deriving them from our own glyph provider is what makes the TeX layout line up
 * with handwriting instead of with Computer Modern.
 */
export function applyHandMetrics(
  katex: { __setFontMetrics: (family: string, metrics: Record<number, number[]>) => void },
  metrics: GlyphMetricsProvider,
  families: readonly string[] = FONT_FAMILIES,
): number {
  let applied = 0;
  for (const family of families) {
    const table: Record<number, number[]> = {};
    for (let cp = 0x20; cp < 0x7f; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!metrics.has(ch)) continue;
      const height = metrics.ascentMm(ch, 1);
      const depth = metrics.descentMm(ch, 1);
      const width = metrics.advanceMm(ch, 1);
      // italic and skew are TeX font-design quantities with no meaning for a
      // photographed glyph; outline-first deletes the research item by making them 0
      // rather than by inventing a derivation nobody could defend.
      table[cp] = [depth, height, 0, 0, width];
    }
    if (Object.keys(table).length === 0) continue;
    katex.__setFontMetrics(family, table);
    applied++;
  }
  return applied;
}

/** em -> mm, once, at the boundary. Invariant I8. */
export function toMm(result: MathWalkResult, sizeMm: Mm): MathWalkResult {
  return {
    glyphs: result.glyphs.map((g) => ({
      ...g,
      xMm: g.xMm * sizeMm,
      baselineYMm: g.baselineYMm * sizeMm,
      sizeMm: g.sizeMm * sizeMm,
      advanceMm: g.advanceMm * sizeMm,
    })),
    widthEm: result.widthEm,
    heightEm: result.heightEm,
    depthEm: result.depthEm,
  };
}
