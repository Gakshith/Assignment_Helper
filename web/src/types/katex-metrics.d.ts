/**
 * KaTeX ships `src/fontMetricsData.js` with no types. Declared here because the math
 * walk MERGES the user's hand into this table rather than replacing it — replacing a
 * family's table deletes every codepoint outside the range supplied, and Main-Regular
 * alone carries 182 above 0x7E (the radical, the big operators, the delimiters).
 *
 * This is a private path in the same sense as `__setFontMetrics`, so it is covered by
 * the same pin and the same contract test.
 */
declare module 'katex/src/fontMetricsData.js' {
  /** family -> codepoint -> [depth, height, italic, skew, width], all in em. */
  const data: Record<string, Record<string, number[]>>;
  export default data;
}
