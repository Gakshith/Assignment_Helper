/**
 * Turning a parsed outline plus a variant affine into an SVG path string.
 *
 * WHY A STRING AND NOT `Path2D.addPath(p, matrix)`. Two reasons, and the second is the
 * one that matters. First, `new Path2D(d)` hands the parse to the browser's own path
 * parser, which is native code and faster than replaying commands through JS method
 * calls. Second, a string is INSPECTABLE: the variant maths is the part of this strand
 * most likely to be subtly wrong (a sign flip in the shear leans every letter the wrong
 * way), and a pure function from commands to a string can be unit-tested in Node, where
 * no canvas exists. Building it through `Path2D` would make the same maths testable only
 * inside a browser.
 *
 * Everything here is y-UP font units in and y-UP font units out. The flip to screen space
 * belongs to paint, at the canvas boundary (invariant I8).
 */

import type { OutlineCommand } from './font';
import type { VariantAffine } from './variants';

/**
 * Two decimals of a font unit. At Caveat's 1000 units/em that is 1e-5 em, which at a
 * 4.2 mm hand and 600 dpi export is about 1/1000 of a device pixel — far below anything
 * a rasteriser can express, and it keeps the string short enough that parsing it is
 * cheap. Trailing zeros are stripped because the string is parsed once per cache entry
 * but MEASURED in bytes against the cache's memory cap.
 */
function n(v: number): string {
  const r = Math.round(v * 100) / 100;
  // `-0` prints as "-0"; harmless in SVG but noisy in a golden string.
  return (r === 0 ? 0 : r).toString();
}

/** Apply the 2x3 affine to a point in y-up font units. */
function ax(m: VariantAffine, x: number, y: number): number {
  return m.a * x + m.c * y + m.e;
}

function ay(m: VariantAffine, x: number, y: number): number {
  return m.b * x + m.d * y + m.f;
}

/**
 * The variant's outline as SVG path data, in y-UP font units.
 *
 * Returns the empty string for a glyph with no contours — a space, a no-break space.
 * That is a real answer, not an absence: `new Path2D('')` is a valid empty path and
 * filling it draws nothing, which is exactly right. Only a character the hand has NO
 * glyph for is an absence, and that is signalled with null one layer up, in provider.ts.
 */
export function pathData(
  commands: readonly OutlineCommand[],
  variant: VariantAffine,
): string {
  const out: string[] = [];
  for (const c of commands) {
    switch (c.op) {
      case 'M':
        out.push(`M${n(ax(variant, c.x, c.y))} ${n(ay(variant, c.x, c.y))}`);
        break;
      case 'L':
        out.push(`L${n(ax(variant, c.x, c.y))} ${n(ay(variant, c.x, c.y))}`);
        break;
      case 'Q':
        out.push(
          `Q${n(ax(variant, c.x1, c.y1))} ${n(ay(variant, c.x1, c.y1))} ` +
            `${n(ax(variant, c.x, c.y))} ${n(ay(variant, c.x, c.y))}`,
        );
        break;
      case 'C':
        out.push(
          `C${n(ax(variant, c.x1, c.y1))} ${n(ay(variant, c.x1, c.y1))} ` +
            `${n(ax(variant, c.x2, c.y2))} ${n(ay(variant, c.x2, c.y2))} ` +
            `${n(ax(variant, c.x, c.y))} ${n(ay(variant, c.x, c.y))}`,
        );
        break;
      case 'Z':
        out.push('Z');
        break;
    }
  }
  return out.join('');
}
