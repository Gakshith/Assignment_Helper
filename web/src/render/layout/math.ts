/**
 * Typesetting a math block: the M3 walk, adapted to what the layout engine needs.
 *
 * Thin by design. All the real work is in `render/math/walk.ts`; this decides how a
 * typeset expression sits in a column — scale to fit, indent, reserve height — and how
 * a parse failure is handed back so the engine can fall back to acceptance row 6's
 * badged verbatim dump rather than rendering something plausible and wrong.
 */

import katex from 'katex';
import { randInt } from '../rng';
import { toMm, walkTree } from '../math/walk';
import type { FigureGeometry, GlyphMetricsProvider, GlyphPlacement } from '../geometry';
import type { Mm } from '../units';

/** Zero-width space, ZWNJ, ZWJ, word joiner, BOM. Layout hints, not glyphs. */
const NON_PRINTING = /[\u200B-\u200D\u2060\uFEFF]/;

/** Display math is indented rather than centred: that is how it is written by hand. */
export const DISPLAY_INDENT_MM = 8;

/** Acceptance row 7's floor applies to math too. */
export const FIT_FLOOR = 0.7;

export type TypesetResult =
  | {
      readonly kind: 'ok';
      readonly glyphs: readonly GlyphPlacement[];
      /**
       * Fraction bars, radical bars and the like. These are RULES, not glyphs: no font
       * has an outline for them, and asking paint to look one up is what made the paint
       * engine correctly complain that metrics and outlines had diverged.
       */
      readonly rules: readonly FigureGeometry[];
      readonly widthMm: Mm;
      readonly heightMm: Mm;
      readonly depthMm: Mm;
      readonly indentMm: Mm;
      readonly fitScale: number;
      readonly overflowMm: Mm | null;
      /** Characters the hand does not have and could not substitute. Acceptance row 5. */
      readonly missing: readonly string[];
    }
  | {
      readonly kind: 'parse-error';
      readonly message: string;
      /** Character offset, when KaTeX reports one. Row 6 asks for it explicitly. */
      readonly position: number | null;
    };

interface KatexPrivate {
  __renderToDomTree: (tex: string, opts?: unknown) => unknown;
}

function parsePosition(err: unknown): number | null {
  const anyErr = err as { position?: number; message?: string };
  if (typeof anyErr?.position === 'number') return anyErr.position;
  // KaTeX's ParseError embeds "at position N" in the message when it has one.
  const m = /at position (\d+)/.exec(anyErr?.message ?? '');
  return m?.[1] ? Number(m[1]) : null;
}

export function typesetMath(
  latex: string,
  display: boolean,
  sizeMm: Mm,
  columnWidthMm: Mm,
  blockSeed: bigint,
  metrics: GlyphMetricsProvider,
): TypesetResult {
  let tree: unknown;
  try {
    tree = (katex as unknown as KatexPrivate).__renderToDomTree(latex, {
      displayMode: display,
      // We consume the box tree, never the markup, so trust is not a rendering concern
      // here — but throwOnError must stay TRUE. KaTeX's default error behaviour is to
      // render the bad source in red and carry on, which would put a plausible-looking
      // wrong formula on a submitted assignment instead of raising a badge.
      throwOnError: true,
      strict: false,
    });
  } catch (err) {
    return {
      kind: 'parse-error',
      message: (err as Error)?.message ?? String(err),
      position: parsePosition(err),
    };
  }

  const walked = walkTree(tree as never);
  const indentMm = display ? DISPLAY_INDENT_MM : 0;
  const available = Math.max(0, columnWidthMm - indentMm);
  const naturalMm = walked.widthEm * sizeMm;

  let fitScale = 1;
  let overflowMm: Mm | null = null;
  if (naturalMm > available && naturalMm > 0) {
    const needed = available / naturalMm;
    if (needed >= FIT_FLOOR) {
      fitScale = needed;
    } else {
      // Row 7: shrink to the floor, then overflow VISIBLY with a badge. Never clip.
      fitScale = FIT_FLOOR;
      overflowMm = naturalMm * FIT_FLOOR - available;
    }
  }

  const scaled = toMm(walked, sizeMm * fitScale);

  /**
   * Acceptance row 5, and this is where it has to happen.
   *
   * Prose reaches paint through text.ts, which only emits a placement for a character
   * `metrics.has()` accepted. Maths does NOT go through text.ts — KaTeX decides which
   * characters exist, and it will happily produce Greek, operators and Size-N delimiters
   * that a handwriting font has never heard of. Without this check the first `\\tau` in a
   * physics problem set reaches a paint engine holding no outline for it.
   *
   * The paint engine handles that correctly and loudly (it throws naming the character),
   * but a thrown render is not the specified behaviour: row 5 says substitute, badge, and
   * keep the page. Layout decides; paint draws.
   */
  const missing: string[] = [];
  const glyphs: GlyphPlacement[] = [];
  const rules: FigureGeometry[] = [];
  scaled.glyphs.forEach((g, i) => {
    if (g.ch === '\u2500') {
      // A rule, emitted as a figure. The walk marks it with a sentinel character
      // because the box tree carries it inline with the glyphs; it is separated here,
      // at the layer that knows the difference between drawing and typesetting.
      rules.push({
        kind: 'line',
        pointsMm: [
          [g.xMm, g.baselineYMm],
          [g.xMm + g.scaleX * sizeMm * fitScale, g.baselineYMm],
        ],
        seed: `math.rule.${i}`,
      });
      return;
    }
    // KaTeX emits zero-width spaces and other non-printing characters as layout hints.
    // They are not missing glyphs and badging them would cry wolf on every expression.
    if (NON_PRINTING.test(g.ch)) return;

    let ch = g.ch;
    if (!metrics.has(ch)) {
      const sub = metrics.substitute(ch);
      if (sub === null || !metrics.has(sub)) {
        // Never a blank and never tofu: the character is recorded and the block badged.
        if (!missing.includes(ch)) missing.push(ch);
        return;
      }
      ch = sub;
    }
    glyphs.push({
      ...g,
      ch,
      // The variant is chosen here, not in the walk: the walk is about TeX geometry and
      // knows nothing about how many variants a hand has.
      variant: randInt(blockSeed, 'math.variant', i, Math.max(1, metrics.variantCount(ch))),
    });
  });

  return {
    kind: 'ok',
    glyphs,
    widthMm: naturalMm * fitScale,
    heightMm: walked.heightEm * sizeMm * fitScale,
    depthMm: walked.depthEm * sizeMm * fitScale,
    rules,
    indentMm,
    fitScale,
    overflowMm,
    missing,
  };
}
