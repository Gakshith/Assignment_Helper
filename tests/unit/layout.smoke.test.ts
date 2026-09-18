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
