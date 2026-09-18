/**
 * The reference hand, tested against the font that actually ships.
 *
 * This reads `web/public/fonts/reference/Caveat-Regular.ttf` off disk rather than a
 * fixture, because the claim under test is "the bundled hand works", and a fixture copy
 * would keep passing after someone swapped the bundled font for a broken one.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_HAND,
  SUBSTITUTIONS,
  VARIANT_COUNT,
  buildHand,
  isReferenceProfile,
  outlinePathData,
  parseHand,
  substituteChar,
  type ParsedHand,
} from '@/render/glyphs/index';

const ROOT = resolve(__dirname, '../..');

function loadReferenceFont(): ParsedHand {
  const bytes = readFileSync(resolve(ROOT, 'web/public', REFERENCE_HAND.fontPath));
  return parseHand(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

const font = loadReferenceFont();
const hand = buildHand(REFERENCE_HAND.profileId, font);

const SIZE_MM = 4.2; // the schema's nominal hand size

describe('the bundled reference hand', () => {
  it('parses, and is a real font rather than a 404 page', () => {
    expect(font.unitsPerEm).toBe(1000);
    expect(font.glyphCount).toBeGreaterThan(200);
  });

  it('answers to the profile id the kernel defaults to', () => {
    // kernel.ts: `style.hand?.profile ?? 'reference'`. If this ever stops being true a
    // fresh launch renders nothing at all (acceptance row 9).
    expect(isReferenceProfile('reference')).toBe(true);
    expect(isReferenceProfile('someone-elses-hand')).toBe(false);
  });

  it('covers every printable ASCII character', () => {
    const missing: string[] = [];
    for (let c = 0x20; c < 0x7f; c++) {
      const ch = String.fromCharCode(c);
      if (!hand.metrics.has(ch)) missing.push(ch);
    }
    expect(missing).toEqual([]);
  });

  it('covers the maths marks an assignment needs', () => {
    for (const ch of '×÷±≤≥≠≈°µ−') {
      expect(hand.metrics.has(ch), `missing ${JSON.stringify(ch)}`).toBe(true);
    }
  });
});

describe('metrics', () => {
  it('reports advances in millimetres, scaling linearly with the nominal size', () => {
    const one = hand.metrics.advanceMm('m', SIZE_MM);
    const two = hand.metrics.advanceMm('m', SIZE_MM * 2);
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(SIZE_MM * 2);
    expect(two).toBeCloseTo(one * 2, 12);
  });

  it('gives an ascender more height than an x-height letter', () => {
    expect(hand.metrics.ascentMm('l', SIZE_MM)).toBeGreaterThan(
      hand.metrics.ascentMm('x', SIZE_MM),
    );
  });

  it('gives a descender real descent and a non-descender almost none', () => {
    expect(hand.metrics.descentMm('g', SIZE_MM)).toBeGreaterThan(
      hand.metrics.descentMm('x', SIZE_MM) * 2,
    );
  });

  it('reports ascent and descent INFLATED past the raw outline, so boxes stay conservative', () => {
    // The variant affine lives inside the outline where layout cannot see it. A box sized
    // to the unperturbed glyph is a box the ink pokes out of.
    const g = font.glyph('l');
    expect(g).not.toBeNull();
    const raw = ((g?.extent.yMax ?? 0) / font.unitsPerEm) * SIZE_MM;
    expect(hand.metrics.ascentMm('l', SIZE_MM)).toBeGreaterThan(raw);
  });

  it('returns NaN rather than a guess for a character it does not have', () => {
    expect(hand.metrics.has('θ')).toBe(false);
    expect(Number.isNaN(hand.metrics.advanceMm('θ', SIZE_MM))).toBe(true);
  });

  it('offers about six variants of an inked glyph and one of a blank one', () => {
    expect(hand.metrics.variantCount('e')).toBe(VARIANT_COUNT);
    expect(VARIANT_COUNT).toBeGreaterThanOrEqual(5);
    expect(VARIANT_COUNT).toBeLessThanOrEqual(8);
    expect(hand.metrics.variantCount(' ')).toBe(1);
  });

  it('measures its own space, so layout does not have to invent a word gap', () => {
    expect(hand.metrics.has(' ')).toBe(true);
    expect(hand.metrics.advanceMm(' ', SIZE_MM)).toBeGreaterThan(0);
  });
});

describe('substitution (acceptance row 5)', () => {
  it('substitutes the marks this hand really is missing', () => {
    // Verified absent from the bundled Caveat, and each replacement is the same stroke
    // under a different code point.
    const live: readonly (readonly [string, string])[] = [
      ['\u2011', '\u002d'], // NON-BREAKING HYPHEN -> HYPHEN-MINUS
      ['\u2012', '\u2013'], // FIGURE DASH -> EN DASH
      ['\u2009', '\u0020'], // THIN SPACE
      ['\u3000', '\u0020'], // IDEOGRAPHIC SPACE
      ['\u22c5', '\u00b7'], // DOT OPERATOR -> MIDDLE DOT
      ['\u2217', '\u002a'], // ASTERISK OPERATOR
      ['\u2236', '\u003a'], // RATIO -> COLON
      ['\u223c', '\u007e'], // TILDE OPERATOR
    ];
    for (const [from, to] of live) {
      expect(hand.metrics.has(from), `${JSON.stringify(from)} should be absent`).toBe(false);
      expect(hand.metrics.substitute(from)).toBe(to);
      expect(hand.metrics.has(to)).toBe(true);
    }
  });

  it('keeps hand-independent Unicode-duplicate rows even when THIS hand needs none', () => {
    // Caveat maps U+03BC directly, so the mu row never fires for it. The table is a claim
    // about Unicode, not about one font, and a hand that carries only the micro sign will
    // need it.
    expect(hand.metrics.has('\u03bc')).toBe(true);
    expect(substituteChar('\u03bc')).toBe('\u00b5');
  });

  it('refuses to lie about a Greek letter or a maths operator', () => {
    // Turning an alpha into an `a` changes what the homework says. Null is the honest
    // answer; layout raises `layout.glyph-missing` and export is blocked until a human
    // has seen the badge.
    for (const ch of 'αβγδθλπσφωΩ→∞∑∫√∈∀') {
      expect(hand.metrics.substitute(ch), `should not substitute ${ch}`).toBeNull();
    }
  });

  it('only ever substitutes a character the hand can actually draw', () => {
    for (const [from, to] of SUBSTITUTIONS) {
      expect(hand.metrics.has(to), `substitute ${JSON.stringify(to)} for ${JSON.stringify(from)}`).toBe(
        true,
      );
    }
  });

  it('never maps a character onto itself, and never chains', () => {
    for (const [from, to] of SUBSTITUTIONS) {
      expect(from).not.toBe(to);
      // A -> B -> C would mean layout's single `substitute()` call could not resolve A.
      expect(substituteChar(to), `${JSON.stringify(to)} is itself substituted`).toBeNull();
    }
  });

  it('earns its keep against the bundled hand', () => {
    // 15 of the 26 rows fire for Caveat; the other 11 are code points it happens to carry
    // itself and are there for hands that do not. The number is asserted so that a future
    // font swap which makes the whole table inert cannot pass unnoticed.
    const live = SUBSTITUTIONS.filter(([from]) => !hand.metrics.has(from));
    expect(live.length).toBeGreaterThanOrEqual(12);
  });

  it('is total and side-effect free', () => {
    expect(substituteChar('e')).toBeNull();
    expect(substituteChar('\u2011')).toBe('\u002d');
    expect(substituteChar('\u2011')).toBe('\u002d');
  });
});

describe('outlines', () => {
  it('emits y-UP path data, as the geometry contract requires', () => {
    const d = outlinePathData(REFERENCE_HAND.profileId, font, 'l', 0);
    expect(d).not.toBeNull();
    const ys = [...(d ?? '').matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2]));
    expect(ys.length).toBeGreaterThan(2);
    // An `l` is almost entirely above the baseline, so in y-up units most of it is
    // positive. If the flip were missing this would be negative.
    expect(Math.max(...ys)).toBeGreaterThan(400);
  });

  it('makes variant 0 the unperturbed letterform', () => {
    // The clean pole of the neatness dial pins every placement to variant 0, and "clean"
    // has to mean the shape the type designer drew.
    const g = font.glyph('e');
    expect(g).not.toBeNull();
    const d0 = outlinePathData(REFERENCE_HAND.profileId, font, 'e', 0) ?? '';
    // First point of the raw outline, y flipped, rounded the way path.ts rounds.
    const first = g?.commands[0];
    expect(first?.op).toBe('M');
    if (first?.op === 'M') {
      expect(d0.startsWith(`M${Math.round(first.x * 100) / 100} ${Math.round(first.y * 100) / 100}`)).toBe(
        true,
      );
    }
  });

  it('gives six DIFFERENT shapes for the same letter', () => {
    const seen = new Set<string>();
    for (let v = 0; v < VARIANT_COUNT; v++) {
      seen.add(outlinePathData(REFERENCE_HAND.profileId, font, 'e', v) ?? '');
    }
    expect(seen.size).toBe(VARIANT_COUNT);
  });

  it('keeps the variant perturbation small enough to still be the same letter', () => {
    const base = outlinePathData(REFERENCE_HAND.profileId, font, 'e', 0) ?? '';
    const baseXs = [...base.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
    for (let v = 1; v < VARIANT_COUNT; v++) {
      const d = outlinePathData(REFERENCE_HAND.profileId, font, 'e', v) ?? '';
      const xs = [...d.matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[1]));
      expect(xs.length).toBe(baseXs.length);
      for (let i = 0; i < xs.length; i++) {
        // Within a fifth of an em of where the letter's contours start. Anything larger
        // and the variant is a different glyph, not a differently-written one.
        expect(Math.abs((xs[i] ?? 0) - (baseXs[i] ?? 0))).toBeLessThan(font.unitsPerEm * 0.2);
      }
    }
  });

  it('is stable across two independent builds of the same profile', () => {
    // A variant belongs to the HAND. The same profile must produce the same alphabet in
    // every document, on every machine, forever.
    const other = buildHand(REFERENCE_HAND.profileId, loadReferenceFont());
    for (let v = 0; v < VARIANT_COUNT; v++) {
      expect(outlinePathData(REFERENCE_HAND.profileId, loadReferenceFont(), 'g', v)).toBe(
        outlinePathData(REFERENCE_HAND.profileId, font, 'g', v),
      );
    }
    expect(other.outlines.profileId).toBe(hand.outlines.profileId);
  });

  it('returns an EMPTY path for a blank glyph and null only for an absent one', () => {
    // The distinction matters: paint turns null into a loud failure, and a space is not
    // a failure.
    expect(outlinePathData(REFERENCE_HAND.profileId, font, ' ', 0)).toBe('');
    expect(outlinePathData(REFERENCE_HAND.profileId, font, 'θ', 0)).toBeNull();
  });

  it('exposes the unitsPerEm paint needs to scale exactly once', () => {
    expect(hand.outlines.unitsPerEm).toBe(font.unitsPerEm);
  });
});

describe('licensing and labelling (acceptance row 9)', () => {
  it('ships the OFL text beside the font', () => {
    const licence = readFileSync(resolve(ROOT, 'web/public', REFERENCE_HAND.licencePath), 'utf8');
    expect(licence).toContain('SIL OPEN FONT LICENSE');
    expect(licence).toContain('Caveat');
  });

  it('labels itself as not being the users handwriting', () => {
    expect(REFERENCE_HAND.label.toLowerCase()).toContain('not your handwriting');
    expect(REFERENCE_HAND.licence).toContain('SIL Open Font License');
  });
});
