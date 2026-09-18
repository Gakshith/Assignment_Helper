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

import FONT_METRICS from 'katex/src/fontMetricsData.js';
import type { GlyphMetricsProvider, GlyphPlacement } from '../geometry';
import type { Mm } from '../units';

/** The sentinel for a RULE (fraction bar, radical bar). Not a font glyph. */
export const RULE_CH = '\u2500';

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
export function walkTree(
  root: KatexNode,
  /**
   * Per-character advance in em, from the hand being drawn in.
   *
   * Needed because KaTeX groups an ordinary run into ONE node: `2.40` arrives as a
   * single node whose `width` is 0.5 — one digit. Advancing every character of the run
   * by the node's width gives the period a full digit's space and renders "2. 40".
   * When this is supplied, a multi-character node is measured character by character.
   */
  advanceEm?: (ch: string) => number,
): MathWalkResult {
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
      const startX = cursor.xEm;
      let widest = startX;
      // Rules emitted inside this vlist. A fraction bar spans the whole vlist, and its
      // width is NOT on the node: KaTeX sizes frac-line with CSS (100% of the vlist),
      // so reading node.width gives 0 and the bar renders as a zero-length line —
      // invisible, and invisible in a way that still looks like a fraction until you
      // look closely at a printed page.
      const ruleIndices: number[] = [];

      for (const row of node.children ?? []) {
        const top = em(row.style?.['top']);
        const pstrut = (row.children ?? []).find((c) => (c.classes ?? []).includes('pstrut'));
        const pstrutH = em(pstrut?.style?.['height']);
        // Positive = below the baseline, matching screen coordinates.
        const shift = pstrutH + top;
        cursor.xEm = startX;
        const before = glyphs.length;
        for (const child of row.children ?? []) visit(child, yEm + shift, scale);
        for (let i = before; i < glyphs.length; i++) {
          if (glyphs[i]!.ch === RULE_CH) ruleIndices.push(i);
        }
        widest = Math.max(widest, cursor.xEm);
      }

      for (const i of ruleIndices) {
        const rule = glyphs[i]!;
        glyphs[i] = { ...rule, xMm: startX, scaleX: widest - startX, advanceMm: widest - startX };
      }

      cursor.xEm = widest;
      maxX = Math.max(maxX, widest);
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
      const nodeWidth = node.width ?? 0;
      const chars = [...node.text];
      // A single-character node: KaTeX's own width is authoritative and already carries
      // the TeX metrics we installed. A multi-character run: measure per character, or
      // the whole run advances by one character's width repeated.
      const perChar =
        chars.length > 1 && advanceEm
          ? chars.map((c) => advanceEm(c))
          : chars.map(() => nodeWidth);

      chars.forEach((ch, i) => {
        const adv = perChar[i] ?? nodeWidth;
        glyphs.push({
          ch,
          xMm: cursor.xEm,
          baselineYMm: yEm,
          sizeMm: scale,
          rotDeg: 0,
          slantDeg: family.includes('Italic') ? -12 : 0,
          scaleX: 1,
          scaleY: 1,
          advanceMm: adv,
        });
        cursor.xEm += adv;
        maxX = Math.max(maxX, cursor.xEm);
      });
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
    /**
     * MERGE, never replace.
     *
     * `__setFontMetrics` swaps the WHOLE table for a family. Handing it a table of just
     * the ASCII range deletes everything else — and Main-Regular alone carries 182
     * codepoints above 0x7E: the radical, the big operators, the stretchy delimiters.
     * The symptom is `Unsupported symbol \surd and font size Main-Regular` on any
     * expression with a square root in it, which is most of a physics problem set.
     *
     * It got past the twelve-expression oracle because the oracle runs BEFORE the
     * metrics are applied — file order, not coverage. A test that only asserts the
     * layout MOVED cannot notice that it also broke.
     */
    const base = FONT_METRICS[family];
    if (!base) continue;

    const table: Record<number, number[]> = {};
    for (const [cp, row] of Object.entries(base)) table[Number(cp)] = row as number[];

    let overridden = 0;
    for (let cp = 0x20; cp < 0x7f; cp++) {
      const ch = String.fromCodePoint(cp);
      if (!metrics.has(ch)) continue;
      const height = metrics.ascentMm(ch, 1);
      const depth = metrics.descentMm(ch, 1);
      const width = metrics.advanceMm(ch, 1);
      if (!Number.isFinite(height) || !Number.isFinite(width) || width <= 0) continue;
      // italic and skew stay 0: they are TeX font-design quantities with no defensible
      // meaning for a photographed glyph, and §C.2 lists that as a research item
      // outline-first deletes rather than answers.
      table[cp] = [depth, height, 0, 0, width];
      overridden++;
    }

    if (overridden === 0) continue;
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
