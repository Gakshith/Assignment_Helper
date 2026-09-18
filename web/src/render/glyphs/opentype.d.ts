/**
 * Types for opentype.js 2.0.0, which ships no declarations of its own.
 *
 * Only the surface this strand actually uses is declared. A partial declaration is
 * deliberate: a hand-written `.d.ts` that claims more API than we call is a lie the
 * compiler cannot catch, and every extra member is one more thing to keep in step with
 * a library we do not control.
 *
 * WHY THE DEEP `/dist/opentype.mjs` IMPORT. The package has no `exports` map, so Node
 * resolves the bare specifier through `main` — the UMD/CJS build, which has no named
 * exports — while Vite resolves it through `module`. Importing the ESM build by path
 * gives the SAME module under Vite, Vitest and plain Node, which is what lets the glyph
 * tests run in the node environment vitest.config.ts selects.
 */

declare module 'opentype.js/dist/opentype.mjs' {
  /** A single drawing command. Coordinates are in font units, y-DOWN (see font.ts). */
  export type PathCommand =
    | { readonly type: 'M'; readonly x: number; readonly y: number }
    | { readonly type: 'L'; readonly x: number; readonly y: number }
    | {
        readonly type: 'Q';
        readonly x1: number;
        readonly y1: number;
        readonly x: number;
        readonly y: number;
      }
    | {
        readonly type: 'C';
        readonly x1: number;
        readonly y1: number;
        readonly x2: number;
        readonly y2: number;
        readonly x: number;
        readonly y: number;
      }
    | { readonly type: 'Z' };

  export interface Path {
    readonly commands: readonly PathCommand[];
  }

  export interface Glyph {
    readonly index: number;
    readonly name: string | null;
    readonly advanceWidth?: number;
    /** `fontSize` is a scale: passing `unitsPerEm` yields raw font units, y-DOWN. */
    getPath(x: number, y: number, fontSize: number): Path;
  }

  export interface Font {
    readonly unitsPerEm: number;
    readonly ascender: number;
    readonly descender: number;
    readonly numGlyphs: number;
    hasChar(ch: string): boolean;
    charToGlyph(ch: string): Glyph;
  }

  export function parse(buffer: ArrayBuffer): Font;
}
