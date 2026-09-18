/**
 * §C.5.6 — the KaTeX private-API contract. PERMANENT.
 *
 * The entire math decision (M3) rests on three UNDERSCORE-PREFIXED private entry
 * points that a patch release can remove with no semver signal at all. This test is
 * the check that was run once by hand on 2026-09-17, made permanent, so the removal
 * surfaces as a red test on a dependency bump rather than as a broken render three
 * weeks into M3.
 *
 * `katex` is pinned exactly in package.json for the same reason. If this test fails
 * after a bump, the correct response is to hold the pin and investigate — not to
 * delete the test.
 */

import { describe, expect, it } from 'vitest';
import katex from 'katex';

type KatexPrivate = typeof katex & {
  __parse: (tex: string, opts?: unknown) => unknown;
  __renderToDomTree: (tex: string, opts?: unknown) => { height: number; depth: number; classes: string[] };
  __renderToHTMLTree: (tex: string, opts?: unknown) => unknown;
  __setFontMetrics: (fontName: string, metrics: Record<number, number[]>) => void;
};

const k = katex as KatexPrivate;

describe('§C.5.6 KaTeX private API', () => {
  it('exposes the three entry points the math walk is built on', () => {
    expect(typeof k.__parse).toBe('function');
    expect(typeof k.__renderToDomTree).toBe('function');
    expect(typeof k.__setFontMetrics).toBe('function');
  });

  it('__renderToDomTree returns a positioned box tree with TeX metrics', () => {
    const tree = k.__renderToDomTree('\\frac{a}{b} + x^2', { displayMode: true });
    expect(tree.height).toBeGreaterThan(0);
    expect(tree.depth).toBeGreaterThan(0);
    expect(tree.classes).toContain('katex-display');
  });

  it('TeX spacing arrives as mspace node data in em, not as CSS', () => {
    // This is what makes the walk possible: the spacing is IN THE TREE, in em, so our
    // own hand's metrics can drive it. If it were CSS we would be reimplementing
    // TeXbook Appendix G instead of reading a number.
    const json = JSON.stringify(k.__renderToDomTree('a + b', {}));
    expect(json).toMatch(/mspace|"0\.2+\d*em"|marginRight/);
  });

  /**
   * MUST RUN LAST IN THIS FILE. __setFontMetrics mutates module-global state and
   * there is no getter to restore from. vitest isolates per file, not per test.
   */
  it('__setFontMetrics actually moves the layout — our hand can drive it', () => {
    const before = k.__renderToDomTree('\\frac{a}{b}', { displayMode: true }).height;
    expect(before).toBeCloseTo(1.10756, 4);

    // The font name must match the font the expression ACTUALLY uses. Measured
    // 2026-09-17: setting 'Main-Regular' does not move \frac{a}{b} at all, because a
    // and b are typeset in Math-Italic. M3's walk must therefore map each box to its
    // own font family before substituting our hand's metrics — a single global
    // substitution silently does nothing for exactly the glyphs that matter most.
    const tall: Record<number, number[]> = {};
    for (let cp = 0x20; cp < 0x7f; cp++) tall[cp] = [0.4, 1.9, 0, 0, 0.6];
    k.__setFontMetrics('Math-Italic', tall);

    const after = k.__renderToDomTree('\\frac{a}{b}', { displayMode: true }).height;
    expect(after).not.toBe(before);
    expect(after).toBeGreaterThan(before);
  });
});
