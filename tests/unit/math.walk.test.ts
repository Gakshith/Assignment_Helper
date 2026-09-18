/**
 * M3 — the KaTeX box-tree walk.
 *
 * S1's twelve-expression oracle, which the plan made the gate for this milestone. Each
 * expression asserts something structural about the output rather than a golden blob,
 * because a golden blob would break on any KaTeX patch release and teach us nothing.
 */

import { describe, expect, it } from 'vitest';
import katex from 'katex';
import { applyHandMetrics, familyFor, toMm, walkTree } from '../../web/src/render/math/walk';
import type { GlyphMetricsProvider } from '../../web/src/render/geometry';

const k = katex as unknown as {
  __renderToDomTree: (tex: string, opts?: unknown) => never;
  __setFontMetrics: (family: string, metrics: Record<number, number[]>) => void;
};

function tree(tex: string, displayMode = true) {
  return k.__renderToDomTree(tex, { displayMode });
}

function walk(tex: string, displayMode = true) {
  return walkTree(tree(tex, displayMode));
}

function chars(tex: string): string {
  return walk(tex)
    .glyphs.map((g) => g.ch)
    .join('');
}

const synthetic: GlyphMetricsProvider = {
  profileId: 'synthetic',
  has: () => true,
  advanceMm: (_c, s) => s * 0.5,
  ascentMm: (_c, s) => s * 0.7,
  descentMm: (_c, s) => s * 0.2,
  variantCount: () => 1,
  substitute: () => null,
};

describe('S1 oracle — the twelve expressions', () => {
  const cases: [string, string][] = [
    ['x + y', 'a binary operator'],
    ['x^2', 'a superscript'],
    ['x_i', 'a subscript'],
    ['x_i^2', 'both at once'],
    ['\\frac{a}{b}', 'a fraction'],
    ['\\frac{\\frac{a}{b}}{c}', 'a nested fraction'],
    ['\\sqrt{x}', 'a radical'],
    ['\\int_0^\\infty e^{-x^2}\\,dx', 'an integral with limits'],
    ['\\sum_{i=1}^{n} i', 'a summation'],
    ['\\alpha\\beta\\gamma', 'greek'],
    ['(x+1)', 'delimiters'],
    ['\\vec{F} = m\\vec{a}', 'accents'],
  ];

  for (const [tex, what] of cases) {
    it(`lays out ${what}: ${tex}`, () => {
      const r = walk(tex);
      expect(r.glyphs.length).toBeGreaterThan(0);
      expect(r.widthEm).toBeGreaterThan(0);
      for (const g of r.glyphs) {
        expect(Number.isFinite(g.xMm)).toBe(true);
        expect(Number.isFinite(g.baselineYMm)).toBe(true);
        expect(Number.isFinite(g.advanceMm)).toBe(true);
      }
      // Nothing may land on top of the previous glyph at the same baseline.
      const sameLine = r.glyphs.filter((g) => Math.abs(g.baselineYMm) < 1e-9);
      for (let i = 1; i < sameLine.length; i++) {
        expect(sameLine[i]!.xMm).toBeGreaterThanOrEqual(sameLine[i - 1]!.xMm - 1e-9);
      }
    });
  }
});

describe('vertical structure', () => {
  it('a fraction puts the numerator above and the denominator below the baseline', () => {
    const r = walk('\\frac{a}{b}');
    const a = r.glyphs.find((g) => g.ch === 'a');
    const b = r.glyphs.find((g) => g.ch === 'b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Screen coordinates: y increases downward.
    expect(a!.baselineYMm).toBeLessThan(0);
    expect(b!.baselineYMm).toBeGreaterThan(0);
    // And they agree with the box KaTeX itself reports.
    expect(b!.baselineYMm).toBeCloseTo(r.depthEm, 2);
  });

  it('emits a rule for the fraction bar, between the two', () => {
    const r = walk('\\frac{a}{b}');
    const rule = r.glyphs.find((g) => g.ch === '─');
    expect(rule).toBeDefined();
    const a = r.glyphs.find((g) => g.ch === 'a')!;
    const b = r.glyphs.find((g) => g.ch === 'b')!;
    expect(rule!.baselineYMm).toBeGreaterThan(a.baselineYMm);
    expect(rule!.baselineYMm).toBeLessThan(b.baselineYMm);
  });

  it('a superscript sits above the baseline and a subscript below', () => {
    const sup = walk('x^2').glyphs.find((g) => g.ch === '2');
    const sub = walk('x_i').glyphs.find((g) => g.ch === 'i');
    expect(sup!.baselineYMm).toBeLessThan(0);
    expect(sub!.baselineYMm).toBeGreaterThan(0);
  });

  it('a nested fraction goes deeper than a flat one', () => {
    expect(walk('\\frac{\\frac{a}{b}}{c}').heightEm).toBeGreaterThan(walk('\\frac{a}{b}').heightEm);
  });
});

describe('horizontal structure', () => {
  it('TeX inter-atom spacing is read from mspace data, not invented', () => {
    // a+b has 0.2222em on each side of the binary operator. Without reading mspace,
    // the glyphs would butt together and the width would be visibly short.
    const withOp = walk('a+b').widthEm;
    const withoutOp = walk('ab').widthEm;
    expect(withOp).toBeGreaterThan(withoutOp + 0.4);
  });

  it('a relation gets more space than an ordinary atom', () => {
    expect(walk('a=b').widthEm).toBeGreaterThan(walk('ab').widthEm);
  });

  it('glyphs advance monotonically left to right on one line', () => {
    const r = walk('abcdef', false);
    const xs = r.glyphs.map((g) => g.xMm);
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
  });
});

describe('correctness guards', () => {
  it('does not walk the MathML mirror and render everything twice', () => {
    // The tree contains a full MathML copy for screen readers. Walking it would emit
    // every symbol twice, invisibly offset, and the bug would look like "ink is bold".
    const text = chars('abc');
    expect(text.split('a').length - 1).toBe(1);
    expect(text.split('b').length - 1).toBe(1);
  });

  it('is deterministic — the same expression twice is identical', () => {
    expect(JSON.stringify(walk('\\frac{a}{b}+x^2'))).toBe(JSON.stringify(walk('\\frac{a}{b}+x^2')));
  });

  it('maps classes to the right font family', () => {
    expect(familyFor(['mord', 'mathnormal'])).toBe('Math-Italic');
    expect(familyFor(['mord'])).toBe('Main-Regular');
    expect(familyFor(['mord', 'mathbf'])).toBe('Main-Bold');
  });

  it('converts em to mm exactly once, at the boundary', () => {
    const r = walk('\\frac{a}{b}');
    const mm = toMm(r, 4.2);
    const a0 = r.glyphs.find((g) => g.ch === 'a')!;
    const a1 = mm.glyphs.find((g) => g.ch === 'a')!;
    expect(a1.xMm).toBeCloseTo(a0.xMm * 4.2, 9);
    expect(a1.baselineYMm).toBeCloseTo(a0.baselineYMm * 4.2, 9);
  });
});

describe('the hand drives the layout', () => {
  // MUST BE LAST: __setFontMetrics mutates KaTeX module state and there is no getter
  // to restore from. vitest isolates per file, not per test.
  it('applying our metrics per family actually moves the layout', () => {
    const before = walk('\\frac{a}{b}').widthEm;
    const applied = applyHandMetrics(k, synthetic);
    expect(applied).toBeGreaterThan(0);
    const after = walk('\\frac{a}{b}').widthEm;
    // The synthetic hand has a 0.5em advance for every character, which is not what
    // Computer Modern has, so the width must change. If this ever stops being true,
    // the hand is NOT driving the layout and M3's whole premise is gone.
    expect(after).not.toBeCloseTo(before, 4);
  });
});

describe('grouped runs are measured per character', () => {
  it('KaTeX groups an ordinary run into one node, and we must not repeat its width', () => {
    // `2.40` arrives as a SINGLE node with width 0.5 — one digit. Advancing every
    // character by that gives the period a full digit's space and renders "2. 40" on
    // the page. Caught by looking at a printed PDF, not by any assertion.
    const tree = tree2('m = 2.40');
    const wide = walkTree(tree, () => 0.9);
    const narrow = walkTree(tree, () => 0.2);
    expect(wide.widthEm).toBeGreaterThan(narrow.widthEm);

    // And a per-character function actually varies the spacing within the run.
    const varied = walkTree(tree, (c) => (c === '.' ? 0.1 : 0.6));
    const xs = varied.glyphs.filter((g) => '2.40'.includes(g.ch)).map((g) => g.xMm);
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!);
    expect(Math.min(...gaps)).toBeLessThan(Math.max(...gaps));
  });
});

function tree2(tex: string) {
  return k.__renderToDomTree(tex, { displayMode: false });
}
