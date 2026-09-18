/**
 * The documented nearest-shape substitution table. Acceptance row 5.
 *
 * ------------------------------------------------------------------------------------
 * THE RULE, AND IT IS NARROW ON PURPOSE.
 *
 * A substitution is allowed only when the replacement is the SAME MARK under a different
 * code point — a Unicode duplicate, a spacing variant, or a punctuation form a reader
 * would not notice had been swapped. Nothing else.
 *
 * In particular this table does NOT map Greek letters or mathematical operators onto
 * Latin lookalikes. `alpha -> a`, `theta -> 0`, `Sigma -> E` are the obvious entries and
 * they are all wrong: this software writes out someone's homework, and silently turning
 * an alpha into an `a` changes what the homework SAYS. The contract's other branch is
 * there for exactly this case — `substitute()` returns null, layout reserves the advance
 * so nothing after it moves, the block carries a `layout.glyph-missing` problem, and
 * §C.5.4 blocks export until a human has seen the badge. A visible refusal to write a
 * character beats a confident wrong character every time.
 *
 * So: no tofu (the contract forbids it), no blank (the contract forbids it), and no
 * plausible lie (this file forbids it).
 * ------------------------------------------------------------------------------------
 *
 * EVERY CODE POINT IS WRITTEN AS AN ESCAPE, INCLUDING THE ONES WITH A PRINTABLE FORM.
 * Half of this table is invisible — a soft hyphen, five kinds of space that are identical
 * on screen — and a table whose rows cannot be told apart by reading them is a table an
 * editor's whitespace normaliser will silently "tidy" one day. The escape is the entry;
 * the comment is the name.
 *
 * The table is a claim about UNICODE, not about any particular font, so it is not
 * conditioned on what the loaded hand contains. Some rows are inert for the bundled
 * reference hand — Caveat maps U+03BC itself — and live for a hand that is not. The
 * caller in layout/text.ts re-checks `has(substitute)` before using a replacement, and
 * falls through to the null branch when the hand lacks it too.
 */

/**
 * source code point -> replacement. An array of pairs rather than an object literal, so
 * the justification cannot drift away from the entry it justifies.
 */
const TABLE: readonly (readonly [string, string])[] = [
  // --- the same mark, a different code point ---------------------------------------
  // Not a lookalike: Unicode's own compatibility decomposition of U+00B5 is U+03BC,
  // and a font that carries both draws one outline twice.
  ['\u03bc', '\u00b5'], // GREEK SMALL LETTER MU -> MICRO SIGN

  // --- hyphens and dashes: all the same stroke -------------------------------------
  ['\u00ad', '\u002d'], // SOFT HYPHEN -> HYPHEN-MINUS
  ['\u2010', '\u002d'], // HYPHEN
  ['\u2011', '\u002d'], // NON-BREAKING HYPHEN
  ['\u2012', '\u2013'], // FIGURE DASH -> EN DASH
  ['\u2015', '\u2014'], // HORIZONTAL BAR -> EM DASH
  ['\u2212', '\u002d'], // MINUS SIGN, for a hand with no dedicated minus

  // --- spaces: a gap is a gap ------------------------------------------------------
  ['\u0009', '\u0020'], // TAB. Layout collapses runs of whitespace; this is a lone one.
  ['\u2002', '\u0020'], // EN SPACE
  ['\u2003', '\u0020'], // EM SPACE
  ['\u2009', '\u0020'], // THIN SPACE
  ['\u202f', '\u0020'], // NARROW NO-BREAK SPACE
  ['\u3000', '\u0020'], // IDEOGRAPHIC SPACE

  // --- quotes and primes -----------------------------------------------------------
  ['\u02bc', '\u0027'], // MODIFIER LETTER APOSTROPHE
  ['\u00b4', '\u0027'], // ACUTE ACCENT, used as an apostrophe
  ['\u2035', '\u2032'], // REVERSED PRIME -> PRIME
  ['\u201a', '\u002c'], // SINGLE LOW-9 QUOTATION MARK -> COMMA

  // --- operator forms of ordinary punctuation --------------------------------------
  // The "maths-typeset" spellings of marks the hand already writes.
  ['\u2219', '\u00b7'], // BULLET OPERATOR -> MIDDLE DOT
  ['\u22c5', '\u00b7'], // DOT OPERATOR -> MIDDLE DOT
  ['\u2217', '\u002a'], // ASTERISK OPERATOR -> ASTERISK
  ['\u2223', '\u007c'], // DIVIDES -> VERTICAL LINE
  ['\u2236', '\u003a'], // RATIO -> COLON
  ['\u2215', '\u002f'], // DIVISION SLASH -> SOLIDUS
  ['\u2044', '\u002f'], // FRACTION SLASH -> SOLIDUS
  ['\u02dc', '\u007e'], // SMALL TILDE -> TILDE
  ['\u223c', '\u007e'], // TILDE OPERATOR -> TILDE
];

const MAP: ReadonlyMap<string, string> = new Map(TABLE);

/**
 * The nearest-shape replacement for `ch`, or null when there is no honest one.
 *
 * Null is a normal, expected answer — see the header. The caller must raise a problem
 * rather than render anything.
 */
export function substituteChar(ch: string): string | null {
  return MAP.get(ch) ?? null;
}

/** Exposed so the tests can assert the whole table rather than a sample of it. */
export const SUBSTITUTIONS = TABLE;
