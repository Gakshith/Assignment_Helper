/**
 * Lead verification of the layout strand. The strand was interrupted before it wrote
 * its own tests, so these are written from its BRIEF rather than from its code — which
 * is the stronger position anyway: a strand's own tests are the weakest evidence it
 * did the right thing.
 */

import { describe, expect, it } from 'vitest';
import { layoutDocument } from '../../web/src/render/layout/engine';
import type { GlyphMetricsProvider } from '../../web/src/render/geometry';
import type { Document, Style } from '../../web/src/types/document';

/** Synthetic and deterministic. Golden geometry must not depend on a font file. */
const metrics: GlyphMetricsProvider = {
  profileId: 'synthetic',
  has: (ch) => ch !== '☃',
  advanceMm: (_ch, sizeMm) => sizeMm * 0.55,
  ascentMm: (_ch, sizeMm) => sizeMm * 0.75,
  descentMm: (_ch, sizeMm) => sizeMm * 0.25,
  variantCount: () => 6,
  substitute: (ch) => (ch === '☃' ? '*' : null),
};

const STYLE: Style = {};

function prose(id: string, text: string, seed = 1234) {
  return { kind: 'prose', id, seed, text } as const;
}

const LOREM =
  'A block of mass m slides down a frictionless ramp inclined at thirty degrees ' +
  'to the horizontal. Find the acceleration of the block along the surface of the ' +
  'ramp, and then determine how long it takes to travel two metres from rest.';

describe('layout engine', () => {
  it('lays out a real paragraph onto pages with glyphs placed', () => {
    const doc: Document = { schema_version: 1, id: 'd', blocks: [prose('b1', LOREM)] };
    const g = layoutDocument(doc, STYLE, metrics);
    expect(g.pages.length).toBeGreaterThanOrEqual(1);
    const block = g.pages[0]!.blocks[0]!;
    expect(block.lines.length).toBeGreaterThan(1);
    const glyphs = block.lines.flatMap((l) => l.glyphs);
    expect(glyphs.length).toBeGreaterThan(100);
    expect(glyphs.every((gl) => Number.isFinite(gl.xMm) && Number.isFinite(gl.baselineYMm))).toBe(true);
  });

  it('I1 — identical inputs give byte-identical geometry', () => {
    const doc: Document = { schema_version: 1, id: 'd', blocks: [prose('b1', LOREM)] };
    const a = JSON.stringify(layoutDocument(doc, STYLE, metrics));
    const b = JSON.stringify(layoutDocument(doc, STYLE, metrics));
    expect(a).toBe(b);
  });

  it('a different block seed re-rolls that block', () => {
    const one: Document = { schema_version: 1, id: 'd', blocks: [prose('b1', LOREM, 1)] };
    const two: Document = { schema_version: 1, id: 'd', blocks: [prose('b1', LOREM, 2)] };
    expect(JSON.stringify(layoutDocument(one, STYLE, metrics))).not.toBe(
      JSON.stringify(layoutDocument(two, STYLE, metrics)),
    );
  });

  it('I3 — editing one block leaves earlier blocks untouched', () => {
    const before: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [prose('b1', LOREM), prose('b2', 'Second block here.')],
    };
    const after: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [prose('b1', LOREM), prose('b2', 'Second block here, edited.')],
    };
    const g1 = layoutDocument(before, STYLE, metrics);
    const g2 = layoutDocument(after, STYLE, metrics);
    const b1a = g1.pages[0]!.blocks.find((b) => b.blockId === 'b1');
    const b1b = g2.pages[0]!.blocks.find((b) => b.blockId === 'b1');
    expect(JSON.stringify(b1b)).toBe(JSON.stringify(b1a));
  });

  it('acceptance row 23 — an empty document is one blank page, not zero and not a crash', () => {
    const g = layoutDocument({ schema_version: 1, id: 'd', blocks: [] }, STYLE, metrics);
    expect(g.pages.length).toBe(1);
    expect(g.pages[0]!.blocks.length).toBe(0);
  });

  it('M3 — math is typeset into real positioned glyphs', () => {
    const doc: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [{ kind: 'math', id: 'm1', seed: 7, latex: '\\frac{a}{b}', display: true }],
    };
    const block = layoutDocument(doc, STYLE, metrics).pages[0]!.blocks[0]!;
    expect(block.problem).toBeUndefined();

    const glyphs = block.lines.flatMap((l) => l.glyphs);
    const a = glyphs.find((g) => g.ch === 'a');
    const b = glyphs.find((g) => g.ch === 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // The numerator sits above the denominator on the page, which is the whole point.
    expect(a!.baselineYMm).toBeLessThan(b!.baselineYMm);
    // And a fraction rule was emitted between them.
    // The fraction rule is a FIGURE, not a glyph — no font has an outline for it.
    expect(block.figures.length).toBeGreaterThan(0);
  });

  it('acceptance row 6 — unparseable LaTeX is badged with the position, page still renders', () => {
    const doc: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [
        prose('b1', 'Before the bad maths.'),
        { kind: 'math', id: 'm1', seed: 7, latex: '\\frac{a}{b', display: true },
        prose('b2', 'After the bad maths.'),
      ],
    };
    const blocks = layoutDocument(doc, STYLE, metrics).pages.flatMap((p) => p.blocks);
    const math = blocks.find((b) => b.blockId === 'm1')!;
    expect(math.problem?.code).toBe('math.parse-error');
    // The source is shown verbatim rather than dropped.
    expect(math.lines.flatMap((l) => l.glyphs).length).toBeGreaterThan(0);
    // The rest of the page is unaffected — row 6 says so explicitly.
    expect(blocks.find((b) => b.blockId === 'b1')!.problem).toBeUndefined();
    expect(blocks.find((b) => b.blockId === 'b2')!.problem).toBeUndefined();
  });

  it('math layout is deterministic', () => {
    const doc: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [{ kind: 'math', id: 'm1', seed: 7, latex: 'x^2 + \\sqrt{y} = z', display: true }],
    };
    expect(JSON.stringify(layoutDocument(doc, STYLE, metrics))).toBe(
      JSON.stringify(layoutDocument(doc, STYLE, metrics)),
    );
  });

  it('acceptance row 5 — a missing glyph substitutes or raises, never renders blank', () => {
    const doc: Document = { schema_version: 1, id: 'd', blocks: [prose('b1', 'snow ☃ man')] };
    const g = layoutDocument(doc, STYLE, metrics);
    const block = g.pages[0]!.blocks[0]!;
    const glyphs = block.lines.flatMap((l) => l.glyphs);
    // Either it was substituted, or the block carries a problem. Never silently dropped.
    const substituted = glyphs.some((gl) => gl.ch === '*');
    expect(substituted || block.problem !== undefined).toBe(true);
  });

  it('a long document paginates rather than running off page one', () => {
    const blocks = Array.from({ length: 40 }, (_, i) => prose(`b${i}`, LOREM, 100 + i));
    const g = layoutDocument({ schema_version: 1, id: 'd', blocks }, STYLE, metrics);
    expect(g.pages.length).toBeGreaterThan(1);
    for (const page of g.pages) {
      for (const b of page.blocks) {
        expect(b.boxMm.yMm + b.boxMm.hMm).toBeLessThanOrEqual(page.heightMm + 0.001);
      }
    }
  });

  it('acceptance row 7 — an unbreakable token scales down, never below the 0.70 floor', () => {
    const giant = 'X'.repeat(400);
    const g = layoutDocument(
      { schema_version: 1, id: 'd', blocks: [prose('b1', giant)] },
      STYLE,
      metrics,
    );
    const block = g.pages[0]!.blocks[0]!;
    expect(block.fitScale).toBeGreaterThanOrEqual(0.7);
    expect(block.fitScale).toBeLessThanOrEqual(1);
  });
});

describe('inline maths flows with the sentence', () => {
  it('a prose/inline-maths/prose run shares one baseline', () => {
    // The parser splits `text $x$ text` into three BLOCKS, because a block is the unit
    // of selection and editing. They must still read as one sentence: without inline
    // continuation a physics paragraph renders as a column of fragments, which is
    // exactly how the first real assignment came out.
    const doc: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [
        { kind: 'prose', id: 'p1', seed: 1, text: 'A block of mass' },
        { kind: 'math', id: 'm1', seed: 2, latex: 'm = 2.40', display: false },
        { kind: 'prose', id: 'p2', seed: 3, text: 'kg slides down.' },
      ],
    };
    const blocks = layoutDocument(doc, STYLE, metrics).pages[0]!.blocks;
    const baselineOf = (id: string) =>
      blocks.find((b) => b.blockId === id)!.lines[0]!.baselineYMm;

    expect(baselineOf('m1')).toBeCloseTo(baselineOf('p1'), 6);
    expect(baselineOf('p2')).toBeCloseTo(baselineOf('p1'), 6);

    // And they advance left to right rather than stacking on the same x.
    const xOf = (id: string) => blocks.find((b) => b.blockId === id)!.lines[0]!.xMm;
    expect(xOf('m1')).toBeGreaterThan(xOf('p1'));
    expect(xOf('p2')).toBeGreaterThan(xOf('m1'));
  });

  it('DISPLAY maths still takes its own row', () => {
    const doc: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [
        { kind: 'prose', id: 'p1', seed: 1, text: 'Therefore' },
        { kind: 'math', id: 'm1', seed: 2, latex: 'v^2 = 2 a d', display: true },
      ],
    };
    const blocks = layoutDocument(doc, STYLE, metrics).pages[0]!.blocks;
    const p1 = blocks.find((b) => b.blockId === 'p1')!.lines[0]!.baselineYMm;
    const m1 = blocks.find((b) => b.blockId === 'm1')!.lines[0]!.baselineYMm;
    expect(m1).toBeGreaterThan(p1);
  });

  it('a heading never resumes a line', () => {
    const doc: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [
        { kind: 'prose', id: 'p1', seed: 1, text: 'End of a paragraph.' },
        { kind: 'prose', id: 'h1', seed: 2, text: 'Problem 2', emphasis: 'heading' },
      ],
    };
    const blocks = layoutDocument(doc, STYLE, metrics).pages[0]!.blocks;
    const p1 = blocks.find((b) => b.blockId === 'p1')!.lines[0]!.baselineYMm;
    const h1 = blocks.find((b) => b.blockId === 'h1')!.lines[0]!.baselineYMm;
    expect(h1).toBeGreaterThan(p1);
  });
});

describe('a boxed answer is one line, not a two-row frame', () => {
  it('inline maths and its unit share a baseline inside the box', () => {
    // `> **Answer:** $v = 4.39$ m/s` parses to a boxed block whose children are inline
    // maths and a unit. Without continuation the unit drops to its own line and the
    // frame grows to two rows around two words — on the most looked-at element of the
    // page.
    const doc: Document = {
      schema_version: 1,
      id: 'd',
      blocks: [
        {
          kind: 'boxed',
          id: 'bx',
          seed: 4,
          children: [
            { kind: 'math', id: 'am', seed: 5, latex: 'v = 4.39', display: false },
            { kind: 'prose', id: 'au', seed: 6, text: 'm/s' },
          ],
        },
      ],
    };
    const box = layoutDocument(doc, STYLE, metrics).pages[0]!.blocks.find(
      (b) => b.kind === 'boxed',
    )!;
    const baselines = [...new Set(box.lines.map((l) => Math.round(l.baselineYMm * 100)))];
    expect(baselines).toHaveLength(1);
    // And the frame is one row tall, not two.
    expect(box.boxMm.hMm).toBeLessThan(18);
  });
});

describe('diagram blocks draw', () => {
  const spec = [
    { kind: 'arrow', points: [[0, 10], [30, 10]] },
    { kind: 'circle', center: [40, 10], r: 6 },
    { kind: 'rect', at: [0, 20], w: 25, h: 10 },
    { kind: 'label', at: [10, 8], text: 'F' },
  ];

  function doc(s: unknown[]): Document {
    return {
      schema_version: 1,
      id: 'd',
      blocks: [{ kind: 'diagram', id: 'fig1', seed: 3, spec: s as never, height_mm: 40 }],
    };
  }

  it('compiles primitives into figures in PAGE coordinates', () => {
    const block = layoutDocument(doc(spec), STYLE, metrics).pages[0]!.blocks[0]!;
    expect(block.problem).toBeUndefined();
    const kinds = block.figures.map((f) => f.kind).sort();
    expect(kinds).toEqual(['arrow', 'circle', 'rect']);
    // Spec coordinates are relative to the block; the emitted ones are absolute, so
    // they must have been shifted past the page's left margin.
    for (const f of block.figures) {
      for (const [x, y] of f.pointsMm) {
        expect(x).toBeGreaterThan(0);
        expect(y).toBeGreaterThan(0);
      }
    }
  });

  it('labels go through the glyph path, not a separate text renderer', () => {
    // A diagram label in a different hand from the prose beside it is the most obvious
    // tell on the page.
    const block = layoutDocument(doc(spec), STYLE, metrics).pages[0]!.blocks[0]!;
    const chars = block.lines.flatMap((l) => l.glyphs.map((g) => g.ch));
    expect(chars).toContain('F');
  });

  it('an unknown primitive is badged, never silently dropped', () => {
    // A diagram that quietly loses the one arrow carrying the meaning still looks
    // like a diagram.
    const block = layoutDocument(doc([{ kind: 'spiral', points: [[0, 0]] }]), STYLE, metrics)
      .pages[0]!.blocks[0]!;
    expect(block.problem?.code).toBe('diagram.unknown-primitive');
  });

  it('a malformed primitive is badged with its index', () => {
    const block = layoutDocument(doc([{ kind: 'circle', center: [1, 1] }]), STYLE, metrics)
      .pages[0]!.blocks[0]!;
    expect(block.problem?.code).toBe('diagram.bad-primitive');
    expect(block.problem?.message).toContain('index 0');
  });

  it('an empty diagram reserves its height and says it is blank', () => {
    const block = layoutDocument(doc([]), STYLE, metrics).pages[0]!.blocks[0]!;
    expect(block.problem?.code).toBe('diagram.empty');
    expect(block.boxMm.hMm).toBeGreaterThanOrEqual(39);
  });
});
