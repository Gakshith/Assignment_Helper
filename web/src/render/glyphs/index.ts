// OWNER: the glyph-provider strand. Replace the export; do not touch main.ts.
import type { GlyphProfileProvider } from '../../app/contracts';
import { createGlyphProfileProvider } from './loader';

export const glyphProfileProvider: GlyphProfileProvider = createGlyphProfileProvider();

export { createGlyphProfileProvider } from './loader';
export { REFERENCE_HAND, isReferenceProfile, type ReferenceHandInfo } from './reference';
export { VARIANT_COUNT } from './variants';
export { SUBSTITUTIONS, substituteChar } from './substitute';
export { parseHand, type ParsedHand } from './font';
export { buildHand, outlinePathData, type Hand } from './provider';
