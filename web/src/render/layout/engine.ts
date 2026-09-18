/**
 * The layout engine: line breaking, pagination, block dispatch, overflow and problems.
 *
 *     layout(document, style, metrics) -> DocumentGeometry
 *
 * Pure. No canvas, no DOM, no clock, no ambient randomness. The only entropy is
 * `rand(blockSeed, purpose, index)` from the frozen rng.ts, and the only ordered
 * collections that reach the output are arrays.
 *
 * ------------------------------------------------------------------------------------
 * I3, BLOCK ISOLATION, AND THE ONE PLACE IT IS IN TENSION WITH ITSELF
 *
 * I3 says editing block i changes block j only if j's line assignment changed. Two
 * things in this engine could couple blocks, and they are handled differently:
 *
 *   - CROWDING is a pure function of a line's own words, so it couples nothing. A line
 *     whose content did not change does not change. No caveat.
 *
 *   - FATIGUE is keyed to the cumulative character count of the PRECEDING blocks, which
 *     is a cross-block dependency by construction — that is what "page 3 is worse than
 *     page 1" means. The alternatives are worse: page index re-rolls everything on
 *     reflow, and block ordinal makes 30 short blocks age the hand faster than 3 long
 *     ones, which inverts the intent. So the input is QUANTISED into 400-character
 *     buckets (params.ts). A typical edit does not move any later block across a bucket
 *     boundary, and when one does, the change is a real change in how much has been
 *     written. Blocks BEFORE an edit are never affected, ever.
 *
 * tests/unit/layout.isolation.test.ts holds both halves of that to account.
 * ------------------------------------------------------------------------------------
 *
 * A BLOCK THAT SPANS A PAGE BREAK emits one BlockGeometry PER PAGE, all sharing the same
 * blockId, each with its own tight boxMm and its own slice of the lines. `BlockGeometry`
 * carries a single `pageIndex`, so this is the only representation the frozen contract
 * admits for prose longer than a page. The kernel's `#flush` matches dirty blocks by
 * blockId and the problem sink dedupes by (code, block_id), so fragments are safe there.
 */

import type {
  BlockGeometry,
  DocumentGeometry,
  FigureGeometry,
  GlyphMetricsProvider,
  LineGeometry,
  PageGeometry,
} from '../geometry';
import { textColumn, type Mm, type RectMm } from '../units';
import { fnv1a64, splitmix64 } from '../rng';
import type { Block, Document, Style } from '../../types/document';
import { q } from './mathfns';
import { typesetMath } from './math';
import { amplitudesFor } from './params';
import { placeLine, quantiseRect, unionRect } from './place';
import { resolveStyle, styleHash, type ResolvedStyle } from './style';
import { breakIntoLines, resolveText, widestWordMm } from './text';

/** Acceptance row 7: a block may shrink this far to fit an unbreakable token, and no further. */
export const FIT_SCALE_FLOOR = 0.7;

/** Vertical room left below the baseline inside a line row, as a ratio of the em. */
const DESCENDER_ALLOWANCE_RATIO = 0.3;
/** Padding between a boxed block's ink and its frame. */
const BOX_PADDING_MM = 1.8;
/** Emphasis size multipliers. */
const EMPHASIS_SCALE = { normal: 1, heading: 1.25, answer: 1.05 } as const;

interface Problem {
  readonly code: string;
  readonly message: string;
}

/** A per-page slice of one block's output. */
interface Fragment {
  readonly pageIndex: number;
  readonly lines: LineGeometry[];
  readonly figures: FigureGeometry[];
  box: RectMm | null;
}

/**
 * The block's RNG stream identity.
 *
 * `seed` alone would make two blocks that happen to share a seed render identically, and
 * documents built by a generator very often hand out the same seed. Mixing the block id
 * in fixes that without breaking I3: the id is part of the block, so changing it is an
 * edit to that block and to nothing else.
 */
function blockSeed(id: string, seed: number): bigint {
  const s = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  return splitmix64((BigInt(s) ^ fnv1a64(id)) & ((1n << 64n) - 1n));
}

/** Characters a block contributes to the fatigue counter. Ink only; spacers do not tire a hand. */
function charCount(block: Block): number {
  switch (block.kind) {
    case 'prose':
      return block.text.length;
    case 'math':
      return block.latex.length;
    case 'boxed':
      return block.children.reduce((n, c) => n + charCount(c), 0);
    default:
      return 0;
  }
}

class LayoutRun {
  readonly #metrics: GlyphMetricsProvider;
  readonly #rs: ResolvedStyle;
  readonly #column: RectMm;
  /** blocksByPage[i] is page i. Index-addressed array, never a Map — I1. */
  readonly #blocksByPage: BlockGeometry[][] = [[]];

  #pageIndex = 0;
  #rowTopMm: Mm;

  constructor(metrics: GlyphMetricsProvider, rs: ResolvedStyle) {
    this.#metrics = metrics;
    this.#rs = rs;
    this.#column = textColumn(rs.page, rs.margins);
    this.#rowTopMm = this.#column.yMm;
  }

  get #columnBottomMm(): Mm {
    return this.#column.yMm + this.#column.hMm;
  }

  #newPage(): void {
    this.#pageIndex += 1;
    this.#blocksByPage.push([]);
    this.#rowTopMm = this.#column.yMm;
  }

  /**
   * On ruled or gridded paper the hand always comes back to a rule. Line rows are already
   * whole multiples of the pitch, so only gaps and reserved heights can knock the text
   * off the grid; this puts it back.
   */
  /**
   * Where the previous flow left off, when the next block may continue on the same line.
   *
   * The markdown parser turns `text $x$ text` into prose / inline-math / prose BLOCKS,
   * because the block is the unit of selection, editing, chat and re-roll. Without this
   * cursor each of those three starts its own line, and a physics paragraph renders as
   * a column of fragments — which is exactly how the first real assignment came out.
   */
  #inline: { xMm: Mm; baselineYMm: Mm } | null = null;
  /** Set by #flowText after each line; read by the caller to update #inline. */
  #lastFlowEndMm: { xMm: Mm; baselineYMm: Mm } | null = null;

  /** The cursor, but only for kinds that are allowed to resume a line. */
  #inlineStartFor(emphasis: string): { xMm: Mm; baselineYMm: Mm } | undefined {
    if (emphasis !== 'normal') return undefined;
    return this.#inline ?? undefined;
  }

  #snap(y: Mm): Mm {
    const pitch = this.#rs.gridPitchMm;
    if (pitch === null || pitch <= 0) return y;
    const offset = y - this.#column.yMm;
    if (offset <= 0) return this.#column.yMm;
    return this.#column.yMm + Math.ceil(offset / pitch - 1e-9) * pitch;
  }

  /** Make room for a row of the given height, starting a page if it does not fit. */
  #ensureRoom(heightMm: Mm): void {
    if (this.#rowTopMm + heightMm <= this.#columnBottomMm) return;
    // A row taller than the whole column can never fit. Put it at the top of a fresh page
    // and let it overflow visibly rather than looping forever looking for a page it fits on.
    if (this.#rowTopMm > this.#column.yMm) this.#newPage();
  }

  #fragmentFor(frags: Fragment[]): Fragment {
    const last = frags[frags.length - 1];
    if (last && last.pageIndex === this.#pageIndex) return last;
    const f: Fragment = { pageIndex: this.#pageIndex, lines: [], figures: [], box: null };
    frags.push(f);
    return f;
  }

  /**
   * Lay out a run of text into the flowing cursor, splitting across pages at line
   * boundaries. Shared by prose, math (as a monospace-ish dump) and boxed children.
   */
  #flowText(args: {
    readonly blockId: string;
    readonly seed: bigint;
    readonly text: string;
    readonly sizeMm: Mm;
    readonly monoAdvanceMm: Mm | null;
    readonly columnWidthMm: Mm;
    readonly xStartMm: Mm;
    readonly charsBefore: number;
    readonly frags: Fragment[];
    readonly problems: Problem[];
    readonly lineIndexBase: number;
    /** Continue an existing line instead of starting a new one. */
    readonly inlineStart?: { xMm: Mm; baselineYMm: Mm } | undefined;
  }): number {
    const amps = amplitudesFor(this.#rs, args.charsBefore);
    const resolved = resolveText(args.text, this.#metrics, args.sizeMm, args.monoAdvanceMm);

    for (const p of resolved.problems) {
      args.problems.push(
        p.code === 'layout.glyph-missing'
          ? {
              code: p.code,
              message: `The hand has no glyph for ${JSON.stringify(p.ch)} and no substitute for it; that character was left blank.`,
            }
          : {
              code: p.code,
              message: `The glyph profile returned an invalid advance for ${JSON.stringify(p.ch)}.`,
            },
      );
    }

    const columnRightMm = this.#column.xMm + this.#column.wMm;
    const firstLineWidthMm = args.inlineStart
      ? Math.max(0, columnRightMm - args.inlineStart.xMm)
      : undefined;
    const lines = breakIntoLines(
      resolved.words,
      args.columnWidthMm,
      resolved.spaceWidthMm,
      firstLineWidthMm,
    );
    const rowHeight = this.#rs.lineAdvanceMm;
    const descender = args.sizeMm * DESCENDER_ALLOWANCE_RATIO;

    let ordinal = 0;
    let lineIndex = args.lineIndexBase;
    let badMetrics = false;

    let continuing = args.inlineStart !== undefined;
    for (const line of lines) {
      let baselineYMm: Mm;
      let xStartMm = args.xStartMm;
      let widthMm = args.columnWidthMm;
      if (continuing && args.inlineStart) {
        // The first line resumes an existing baseline; no new row is reserved for it.
        baselineYMm = args.inlineStart.baselineYMm;
        xStartMm = args.inlineStart.xMm;
        widthMm = Math.max(0, columnRightMm - args.inlineStart.xMm);
        continuing = false;
      } else {
        this.#ensureRoom(rowHeight);
        baselineYMm = this.#rowTopMm + rowHeight - descender;
      }

      const placed = placeLine({
        blockId: args.blockId,
        lineIndex,
        line,
        baselineYMm,
        xStartMm,
        columnWidthMm: widthMm,
        sizeMm: args.sizeMm,
        spaceWidthMm: resolved.spaceWidthMm,
        seed: args.seed,
        amps,
        baseSlantDeg: this.#rs.slantDeg,
        charOrdinal: ordinal,
        metrics: this.#metrics,
      });
      if (placed.badMetrics) badMetrics = true;

      const frag = this.#fragmentFor(args.frags);
      frag.lines.push(placed.geometry);
      frag.box = unionRect(frag.box, placed.inkBox);

      ordinal = placed.nextCharOrdinal;
      lineIndex += 1;
      // Where this line ended, so a following inline block can resume from it.
      this.#lastFlowEndMm = placed.inkBox
        ? { xMm: placed.inkBox.xMm + placed.inkBox.wMm + resolved.spaceWidthMm, baselineYMm }
        : { xMm: xStartMm, baselineYMm };
      if (!(lineIndex - args.lineIndexBase === 1 && args.inlineStart)) {
        this.#rowTopMm += rowHeight;
      }
    }

    if (badMetrics) {
      args.problems.push({
        code: 'layout.bad-metrics',
        message: 'The glyph profile returned a non-finite ascent or descent; the block box is approximate.',
      });
    }

    return lineIndex - args.lineIndexBase;
  }

  /**
   * Acceptance row 7, second half. A token wider than the column scales the block down to
   * fit, to a floor of 0.70, and then overflows VISIBLY with a problem rather than being
   * clipped. Nothing here ever clips: the block's box is the union of the ink that was
   * actually emitted, overflow included, so paint has no reason to crop and the lasso
   * still finds the runaway token.
   */
  #fitScaleFor(text: string, sizeMm: Mm, monoAdvanceMm: Mm | null, columnWidthMm: Mm): {
    fitScale: number;
    overflow: Mm | null;
  } {
    const probe = resolveText(text, this.#metrics, sizeMm, monoAdvanceMm);
    const widest = widestWordMm(probe.words);
    if (widest <= columnWidthMm || widest <= 0) return { fitScale: 1, overflow: null };

    const needed = columnWidthMm / widest;
    if (needed >= FIT_SCALE_FLOOR) return { fitScale: needed, overflow: null };
    return { fitScale: FIT_SCALE_FLOOR, overflow: widest * FIT_SCALE_FLOOR - columnWidthMm };
  }

  #emit(args: {
    readonly blockId: string;
    readonly kind: string;
    readonly frags: readonly Fragment[];
    readonly problems: readonly Problem[];
    readonly fitScale: number;
    readonly fallbackBox: RectMm | null;
  }): void {
    const problem = pickProblem(args.kind, args.problems);
    const fragments = args.frags.length > 0
      ? args.frags
      : args.fallbackBox
        ? [{ pageIndex: this.#pageIndex, lines: [], figures: [], box: args.fallbackBox }]
        : [];

    for (const f of fragments) {
      const box = f.box ?? args.fallbackBox ?? { xMm: this.#column.xMm, yMm: this.#rowTopMm, wMm: 0, hMm: 0 };
      const geometry: BlockGeometry = {
        blockId: args.blockId,
        kind: args.kind,
        boxMm: quantiseRect(box),
        pageIndex: f.pageIndex,
        lines: f.lines,
        figures: f.figures,
        ...(problem ? { problem } : {}),
        fitScale: q(args.fitScale),
      };
      const page = this.#blocksByPage[f.pageIndex];
      if (!page) {
        // Cannot happen: fragments only ever name a page this run created. Not swallowed,
        // because a silently dropped block is exactly the failure I5 exists to prevent.
        throw new Error(`layout: fragment names page ${f.pageIndex}, which was never created`);
      }
      page.push(geometry);
    }
  }

  /** Reserve a vertical box with no text: spacer and diagram. */
  #reserve(heightMm: Mm): RectMm {
    const h = Number.isFinite(heightMm) && heightMm > 0 ? heightMm : 0;
    this.#ensureRoom(h);
    const box: RectMm = { xMm: this.#column.xMm, yMm: this.#rowTopMm, wMm: this.#column.wMm, hMm: h };
    this.#rowTopMm = this.#snap(this.#rowTopMm + h);
    return box;
  }

  layoutBlock(block: Block, charsBefore: number): void {
    const problems: Problem[] = [];
    const frags: Fragment[] = [];
    const seed = blockSeed(block.id, block.seed);

    switch (block.kind) {
      case 'spacer': {
        // Nothing resumes a line across this.
        this.#inline = null;
        const box = this.#reserve(block.height_mm);
        this.#emit({ blockId: block.id, kind: 'spacer', frags: [], problems, fitScale: 1, fallbackBox: box });
        return;
      }

      case 'diagram': {
        // Nothing resumes a line across this.
        this.#inline = null;
        // The figures strand fills this in. Until then the height is reserved so the rest
        // of the page is already correct, and the badge says why the space is empty.
        const box = this.#reserve(block.height_mm ?? 40);
        problems.push({
          code: 'diagram.not-implemented',
          message: `Diagrams are not drawn yet; ${box.hMm.toFixed(1)} mm is reserved for this one.`,
        });
        this.#emit({ blockId: block.id, kind: 'diagram', frags: [], problems, fitScale: 1, fallbackBox: box });
        return;
      }

      case 'math': {
        // M3: the KaTeX box-tree walk. A parse failure falls through to the verbatim
        // dump below, which is acceptance row 6 — badged monospace source with the
        // error position, and the rest of the page renders normally.
        const size = this.#rs.sizeMm;
        const typeset = typesetMath(
          block.latex,
          block.display ?? true,
          size,
          this.#column.wMm,
          seed,
          this.#metrics,
        );

        if (typeset.kind === 'ok') {
          /**
           * Inline maths continues the current line when it fits.
           *
           * `$m = 2.40$` in the middle of a sentence is one block, because the block is
           * the unit of selection and editing — but it must READ as part of the
           * sentence. Without this the parser's prose/maths/prose split renders as three
           * separate lines and a physics paragraph becomes a column of fragments.
           */
          const inline = block.display === false ? this.#inline : null;
          const columnRightMm = this.#column.xMm + this.#column.wMm;
          const fitsInline =
            inline !== null && inline.xMm + typeset.widthMm <= columnRightMm;

          if (fitsInline && inline) {
            const xMm = inline.xMm;
            const baselineYMm = inline.baselineYMm;
            const line: LineGeometry = {
              blockId: block.id,
              lineIndex: 0,
              baselineYMm,
              xMm,
              widthMm: typeset.widthMm,
              glyphs: typeset.glyphs.map((g) => ({
                ...g,
                xMm: xMm + g.xMm,
                baselineYMm: baselineYMm + g.baselineYMm,
              })),
            };
            const frag = this.#fragmentFor(frags);
            frag.lines.push(line);
            for (const r of typeset.rules) {
              frag.figures.push({
                ...r,
                pointsMm: r.pointsMm.map(
                  (pt) => [xMm + pt[0], baselineYMm + pt[1]] as readonly [Mm, Mm],
                ),
                seed: `${block.id}:${r.seed}`,
              });
            }
            const boxMm: RectMm = {
              xMm,
              yMm: baselineYMm - typeset.heightMm,
              wMm: typeset.widthMm,
              hMm: typeset.heightMm + typeset.depthMm,
            };
            frag.box = unionRect(frag.box, boxMm);
            // Hand the line on to whatever follows, plus a word space — without it the
            // next word butts straight onto the maths and reads as "2.40kg".
            const spaceMm = this.#metrics.advanceMm(' ', this.#rs.sizeMm);
            this.#inline = { xMm: xMm + typeset.widthMm + spaceMm, baselineYMm };
            if (typeset.missing.length > 0) {
              problems.push({
                code: 'glyph.missing',
                message:
                  `The hand has no glyph for ${typeset.missing.map((c) => JSON.stringify(c)).join(', ')}. ` +
                  'Draw them in the glyph studio, or the maths will be incomplete.',
              });
            }
            this.#emit({
              blockId: block.id,
              kind: 'math',
              frags,
              problems,
              fitScale: typeset.fitScale,
              fallbackBox: null,
            });
            return;
          }

          // Display maths, or inline maths that will not fit: its own row.
          this.#inline = null;
          const box = this.#reserve(typeset.heightMm + typeset.depthMm);
          const baselineYMm = box.yMm + typeset.heightMm;
          const xMm = this.#column.xMm + typeset.indentMm;
          const line: LineGeometry = {
            blockId: block.id,
            lineIndex: 0,
            baselineYMm,
            xMm,
            widthMm: typeset.widthMm,
            glyphs: typeset.glyphs.map((g) => ({
              ...g,
              xMm: xMm + g.xMm,
              baselineYMm: baselineYMm + g.baselineYMm,
            })),
          };
          if (typeset.overflowMm !== null) problems.push(overflowProblem(typeset.overflowMm));
          if (typeset.missing.length > 0) {
            problems.push({
              code: 'glyph.missing',
              message:
                `The hand has no glyph for ${typeset.missing.map((c) => JSON.stringify(c)).join(', ')}. ` +
                'Draw them in the glyph studio, or the maths will be incomplete.',
            });
          }
          frags.push({
            pageIndex: this.#pageIndex,
            lines: [line],
            figures: typeset.rules.map((r) => ({
              ...r,
              pointsMm: r.pointsMm.map(
                (pt) => [xMm + pt[0], baselineYMm + pt[1]] as readonly [Mm, Mm],
              ),
              seed: `${block.id}:${r.seed}`,
            })),
            box: { xMm, yMm: box.yMm, wMm: typeset.widthMm, hMm: box.hMm },
          });
          this.#emit({
            blockId: block.id,
            kind: 'math',
            frags,
            problems,
            fitScale: typeset.fitScale,
            fallbackBox: null,
          });
          return;
        }

        const mono = monoAdvanceFor(block.latex, this.#metrics, size);
        const fit = this.#fitScaleFor(block.latex, size, mono, this.#column.wMm);
        const scaled = size * fit.fitScale;
        const monoScaled = mono * fit.fitScale;
        // Acceptance row 6. The position matters: "it did not parse" sends the user
        // hunting through the whole expression.
        const at = typeset.position !== null ? ` at character ${typeset.position}` : '';
        problems.push({
          code: 'math.parse-error',
          message: `This LaTeX could not be parsed${at}: ${typeset.message}`,
        });
        if (fit.overflow !== null) problems.push(overflowProblem(fit.overflow));
        this.#flowText({
          blockId: block.id,
          seed,
          text: block.latex,
          sizeMm: scaled,
          monoAdvanceMm: monoScaled,
          columnWidthMm: this.#column.wMm,
          xStartMm: this.#column.xMm,
          charsBefore,
          frags,
          problems,
          lineIndexBase: 0,
        });
        this.#emit({ blockId: block.id, kind: 'math', frags, problems, fitScale: fit.fitScale, fallbackBox: null });
        return;
      }

      case 'prose': {
        // Continues a line left open by an inline maths block, and leaves one open for
        // the next. Only NORMAL prose flows inline: a heading or a boxed answer that
        // resumed mid-line would be a different bug.
        const size = this.#rs.sizeMm * EMPHASIS_SCALE[block.emphasis ?? 'normal'];
        const fit = this.#fitScaleFor(block.text, size, null, this.#column.wMm);
        if (fit.overflow !== null) problems.push(overflowProblem(fit.overflow));
        this.#flowText({
          blockId: block.id,
          seed,
          text: block.text,
          sizeMm: size * fit.fitScale,
          monoAdvanceMm: null,
          columnWidthMm: this.#column.wMm,
          xStartMm: this.#column.xMm,
          charsBefore,
          frags,
          problems,
          lineIndexBase: 0,
          inlineStart: this.#inlineStartFor(block.emphasis ?? 'normal'),
        });
        this.#inline = block.emphasis === 'heading' ? null : this.#lastFlowEndMm;
        this.#emit({ blockId: block.id, kind: 'prose', frags, problems, fitScale: fit.fitScale, fallbackBox: null });
        return;
      }

      case 'boxed': {
        // Nothing resumes a line across this.
        this.#inline = null;
        // Lay the children out inside an inset column, then frame the union of their ink.
        // The boxed answer is ONE selectable unit — that is what a boxed final answer is —
        // so the children do not get BlockGeometry entries of their own. Each child keeps
        // its OWN seed, so editing one child re-rolls only that child.
        const inset = BOX_PADDING_MM * 2;
        const innerWidth = Math.max(1, this.#column.wMm - inset);
        const innerX = this.#column.xMm + BOX_PADDING_MM;

        this.#rowTopMm = this.#snap(this.#rowTopMm + BOX_PADDING_MM);

        let childChars = charsBefore;
        let lineBase = 0;
        for (const child of block.children) {
          lineBase += this.#layoutBoxedChild({
            parentId: block.id,
            child,
            charsBefore: childChars,
            innerX,
            innerWidth,
            frags,
            problems,
            lineIndexBase: lineBase,
          });
          childChars += charCount(child);
        }

        this.#rowTopMm = this.#snap(this.#rowTopMm + BOX_PADDING_MM);

        for (const f of frags) {
          if (f.box === null) continue;
          const framed: RectMm = {
            xMm: f.box.xMm - BOX_PADDING_MM,
            yMm: f.box.yMm - BOX_PADDING_MM,
            wMm: f.box.wMm + inset,
            hMm: f.box.hMm + inset,
          };
          f.figures.push({
            kind: 'rect',
            pointsMm: [
              [q(framed.xMm), q(framed.yMm)],
              [q(framed.xMm + framed.wMm), q(framed.yMm + framed.hMm)],
            ],
            seed: `${block.id}:box:${f.pageIndex}`,
          });
          f.box = framed;
        }

        this.#emit({ blockId: block.id, kind: 'boxed', frags, problems, fitScale: 1, fallbackBox: null });
        return;
      }
    }
  }

  #layoutBoxedChild(args: {
    readonly parentId: string;
    readonly child: Block;
    readonly charsBefore: number;
    readonly innerX: Mm;
    readonly innerWidth: Mm;
    readonly frags: Fragment[];
    readonly problems: Problem[];
    readonly lineIndexBase: number;
  }): number {
    const { child } = args;
    const seed = blockSeed(child.id, child.seed);

    if (child.kind === 'spacer') {
      this.#rowTopMm = this.#snap(this.#rowTopMm + Math.max(0, child.height_mm));
      return 0;
    }
    if (child.kind === 'diagram') {
      const h = child.height_mm ?? 40;
      this.#ensureRoom(h);
      const box: RectMm = { xMm: args.innerX, yMm: this.#rowTopMm, wMm: args.innerWidth, hMm: h };
      const frag = this.#fragmentFor(args.frags);
      frag.box = unionRect(frag.box, box);
      this.#rowTopMm = this.#snap(this.#rowTopMm + h);
      args.problems.push({
        code: 'diagram.not-implemented',
        message: 'A diagram inside this boxed answer is not drawn yet; its height is reserved.',
      });
      return 0;
    }
    if (child.kind === 'boxed') {
      // Nesting deeper than one box is not a v1 shape. Flatten rather than recurse into
      // an unbounded frame-in-frame, and say so instead of quietly dropping the content.
      args.problems.push({
        code: 'layout.nested-box',
        message: 'A boxed block inside a boxed block is drawn as plain content; nested frames are not v1.',
      });
      let n = 0;
      let chars = args.charsBefore;
      for (const grand of child.children) {
        n += this.#layoutBoxedChild({ ...args, child: grand, charsBefore: chars, lineIndexBase: args.lineIndexBase + n });
        chars += charCount(grand);
      }
      return n;
    }

    if (child.kind === 'math') {
      // The same M3 path as a top-level math block. A boxed FINAL ANSWER is the single
      // most likely place for maths in a problem set, so leaving this on the verbatim
      // dump would mean the one equation a marker looks hardest at is the one shown as
      // raw LaTeX.
      const typeset = typesetMath(
        child.latex,
        child.display ?? true,
        this.#rs.sizeMm,
        args.innerWidth,
        seed,
        this.#metrics,
      );
      if (typeset.kind === 'ok') {
        const h = typeset.heightMm + typeset.depthMm;
        this.#ensureRoom(h);
        const baselineYMm = this.#rowTopMm + typeset.heightMm;
        const xMm = args.innerX;
        const frag = this.#fragmentFor(args.frags);
        frag.lines.push({
          blockId: args.parentId,
          lineIndex: args.lineIndexBase,
          baselineYMm,
          xMm,
          widthMm: typeset.widthMm,
          glyphs: typeset.glyphs.map((g) => ({
            ...g,
            xMm: xMm + g.xMm,
            baselineYMm: baselineYMm + g.baselineYMm,
          })),
        });
        for (const r of typeset.rules) {
          frag.figures.push({
            ...r,
            pointsMm: r.pointsMm.map(
              (pt) => [xMm + pt[0], baselineYMm + pt[1]] as readonly [Mm, Mm],
            ),
            seed: `${args.parentId}:${r.seed}`,
          });
        }
        frag.box = unionRect(frag.box, {
          xMm,
          yMm: this.#rowTopMm,
          wMm: typeset.widthMm,
          hMm: h,
        });
        this.#rowTopMm = this.#snap(this.#rowTopMm + h);
        if (typeset.overflowMm !== null) args.problems.push(overflowProblem(typeset.overflowMm));
        if (typeset.missing.length > 0) {
          args.problems.push({
            code: 'glyph.missing',
            message:
              `The hand has no glyph for ${typeset.missing.map((c) => JSON.stringify(c)).join(', ')} ` +
              'in this boxed answer.',
          });
        }
        return 1;
      }
      const at = typeset.position !== null ? ` at character ${typeset.position}` : '';
      args.problems.push({
        code: 'math.parse-error',
        message: `LaTeX in this boxed answer could not be parsed${at}: ${typeset.message}`,
      });
    }

    const isMath = child.kind === 'math';
    const text = isMath ? child.latex : child.text;
    const size =
      this.#rs.sizeMm * (isMath ? 1 : EMPHASIS_SCALE[child.emphasis ?? 'normal']);
    const mono = isMath ? monoAdvanceFor(text, this.#metrics, size) : null;
    const fit = this.#fitScaleFor(text, size, mono, args.innerWidth);
    if (fit.overflow !== null) args.problems.push(overflowProblem(fit.overflow));

    return this.#flowText({
      blockId: args.parentId,
      seed,
      text,
      sizeMm: size * fit.fitScale,
      monoAdvanceMm: mono === null ? null : mono * fit.fitScale,
      columnWidthMm: args.innerWidth,
      xStartMm: args.innerX,
      charsBefore: args.charsBefore,
      frags: args.frags,
      problems: args.problems,
      lineIndexBase: args.lineIndexBase,
    });
  }

  finish(styleHashValue: string): DocumentGeometry {
    const pages: PageGeometry[] = this.#blocksByPage.map((blocks, pageIndex) => ({
      pageIndex,
      widthMm: this.#rs.page.widthMm,
      heightMm: this.#rs.page.heightMm,
      blocks,
    }));
    return {
      // Acceptance row 23: an empty document is one blank page, never zero and never a throw.
      pages: pages.length > 0 ? pages : [emptyPage(this.#rs)],
      // CONTRACT NOTE: `layout(doc, style, metrics)` is not given the document version —
      // `Document` has `schema_version`, which is the SCHEMA's version, not the store's.
      // -1 is what the seam-freeze stub returns and it is the honest answer: it makes the
      // kernel re-run layout rather than trust a number layout cannot know. Reported to
      // the lead as a contract observation, not worked around.
      docVersion: -1,
      styleHash: styleHashValue,
    };
  }
}

function emptyPage(rs: ResolvedStyle): PageGeometry {
  return { pageIndex: 0, widthMm: rs.page.widthMm, heightMm: rs.page.heightMm, blocks: [] };
}

function overflowProblem(overflowMm: Mm): Problem {
  return {
    code: 'layout.overflow',
    message: `A single unbreakable token is wider than the text column even at the ${FIT_SCALE_FLOOR.toFixed(2)} minimum scale; it overflows the margin by ${overflowMm.toFixed(1)} mm.`,
  };
}

/**
 * The math placeholder is monospace-ish, and the cell width comes from the widest
 * character in THIS expression rather than from a guessed reference glyph — so it stays
 * monospace whatever the profile happens to contain.
 */
function monoAdvanceFor(latex: string, metrics: GlyphMetricsProvider, sizeMm: Mm): Mm {
  let widest = sizeMm * 0.55;
  for (const ch of latex) {
    if (ch === '\n' || ch === ' ') continue;
    const a = metrics.has(ch) ? metrics.advanceMm(ch, sizeMm) : sizeMm * 0.55;
    if (Number.isFinite(a) && a > widest) widest = a;
  }
  return widest;
}

/**
 * `BlockGeometry.problem` is singular, so when a block has several the most
 * badge-worthy one wins and the rest are named in its message. Nothing is dropped —
 * I5 is about the user finding out, not about the shape of the field.
 */
const PROBLEM_RANK: readonly string[] = [
  'math.not-implemented',
  'diagram.not-implemented',
  'layout.overflow',
  'layout.glyph-missing',
  'layout.bad-metrics',
  'layout.nested-box',
];

function pickProblem(kind: string, problems: readonly Problem[]): Problem | null {
  if (problems.length === 0) return null;

  // The kind-defining badge leads for math and diagram; otherwise severity does.
  const rankOf = (p: Problem): number => {
    if (kind === 'math' && p.code === 'math.not-implemented') return -1;
    if (kind === 'diagram' && p.code === 'diagram.not-implemented') return -1;
    const i = PROBLEM_RANK.indexOf(p.code);
    return i === -1 ? PROBLEM_RANK.length : i;
  };

  let best = problems[0] as Problem;
  let bestRank = rankOf(best);
  for (const p of problems) {
    const r = rankOf(p);
    if (r < bestRank) {
      best = p;
      bestRank = r;
    }
  }

  if (problems.length === 1) return best;
  const others: string[] = [];
  for (const p of problems) {
    if (p === best) continue;
    if (!others.includes(p.code)) others.push(p.code);
  }
  if (others.length === 0) return best;
  return { code: best.code, message: `${best.message} (also: ${others.join(', ')})` };
}

/** The strand's entry point. Referenced by index.ts, which main.ts imports from a fixed path. */
export function layoutDocument(
  doc: Document,
  style: Style,
  metrics: GlyphMetricsProvider,
): DocumentGeometry {
  const rs = resolveStyle(style);
  const run = new LayoutRun(metrics, rs);

  const blocks = doc.blocks ?? [];
  let cumulativeChars = 0;
  for (const block of blocks) {
    run.layoutBlock(block, cumulativeChars);
    cumulativeChars += charCount(block);
  }

  return run.finish(styleHash(style));
}
