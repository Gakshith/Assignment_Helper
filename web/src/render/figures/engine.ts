/**
 * Diagram primitives, drawn with a hand rather than a ruler.
 *
 * The only figure v1 actually emits is the frame around a boxed answer, and that frame
 * matters more than it sounds: a boxed final answer is a convention markers look for,
 * and a perfectly straight rectangle on a page of handwriting reads as pasted-in.
 *
 * Every wobble is derived from the figure's own `seed` string through the counter-based
 * RNG, so a frame is identical on every repaint and identical in export (I1). No
 * `Math.random` — the integration harness greps for it.
 */

import type { FiguresRenderer, PageLayers, Style } from '../../app/contracts';
import type { FigureGeometry, PageGeometry } from '../geometry';
import { fnv1a64, randSigned } from '../rng';
import { mmToPx, type Mm } from '../units';

/** How far a hand-drawn line wanders from true, at full untidiness. */
const WOBBLE_MM = 0.45;
/** Segment length along a stroke. Shorter = more wobble detail, more work. */
const SEGMENT_MM = 6;
const STROKE_MM = 0.32;

function seedOf(figure: FigureGeometry): bigint {
  return fnv1a64(figure.seed);
}

/** A straight run, drawn as a shallow polyline that drifts off true and back. */
function handLine(
  ctx: CanvasRenderingContext2D,
  seed: bigint,
  purpose: string,
  x0: Mm,
  y0: Mm,
  x1: Mm,
  y1: Mm,
  amp: number,
  dpi: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthMm = Math.hypot(dx, dy);
  const steps = Math.max(2, Math.ceil(lengthMm / SEGMENT_MM));
  // Unit normal, so the wobble is across the stroke rather than along it — wobbling
  // along a line just makes it longer and shorter, which reads as nothing at all.
  const nx = lengthMm === 0 ? 0 : -dy / lengthMm;
  const ny = lengthMm === 0 ? 0 : dx / lengthMm;

  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ends are pinned: a corner that does not meet reads as a mistake, not as a hand.
    const taper = Math.sin(Math.PI * t);
    const off = randSigned(seed, purpose, i, amp) * taper;
    const xMm = x0 + dx * t + nx * off;
    const yMm = y0 + dy * t + ny * off;
    const x = mmToPx(xMm, dpi);
    const y = mmToPx(yMm, dpi);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export class SketchFiguresRenderer implements FiguresRenderer {
  readonly name = 'figures';

  paintFigures(layers: PageLayers, page: PageGeometry, style: Style): void {
    const figures = page.blocks.flatMap((b) => b.figures);
    if (figures.length === 0) return;

    const ctx = layers.ink.getContext('2d');
    // I5: no context is a broken app, not a page that quietly draws nothing.
    if (!ctx) throw new Error('figures: no 2d context on the ink layer');

    const dpi = layers.dpi;
    const neatness = style.hand?.neatness ?? 0.5;
    const amp = WOBBLE_MM * (1 - neatness);

    ctx.save();
    ctx.strokeStyle = style.hand?.ink_colour ?? '#1C2521';
    ctx.lineWidth = Math.max(1, mmToPx(STROKE_MM, dpi));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const figure of figures) {
      const seed = seedOf(figure);
      const pts = figure.pointsMm;
      switch (figure.kind) {
        case 'rect': {
          const a = pts[0];
          const b = pts[1];
          if (!a || !b) break;
          const [x0, y0] = a;
          const [x1, y1] = b;
          // Four separate strokes, each with its own wobble stream. Drawing it as one
          // closed path would make all four sides share a wobble and read as a shape
          // that was scaled rather than drawn.
          handLine(ctx, seed, 'rect.top', x0, y0, x1, y0, amp, dpi);
          handLine(ctx, seed, 'rect.right', x1, y0, x1, y1, amp, dpi);
          handLine(ctx, seed, 'rect.bottom', x1, y1, x0, y1, amp, dpi);
          handLine(ctx, seed, 'rect.left', x0, y1, x0, y0, amp, dpi);
          break;
        }
        case 'line':
        case 'axis': {
          for (let i = 1; i < pts.length; i++) {
            const p = pts[i - 1];
            const q = pts[i];
            if (!p || !q) continue;
            handLine(ctx, seed, `line.${i}`, p[0], p[1], q[0], q[1], amp, dpi);
          }
          break;
        }
        case 'arrow': {
          const p = pts[0];
          const q = pts[pts.length - 1];
          if (!p || !q) break;
          handLine(ctx, seed, 'arrow.shaft', p[0], p[1], q[0], q[1], amp, dpi);
          const angle = Math.atan2(q[1] - p[1], q[0] - p[0]);
          const headMm = 2.4;
          for (const [i, spread] of [0.4, -0.4].entries()) {
            const a = angle + Math.PI + spread;
            handLine(
              ctx,
              seed,
              `arrow.head.${i}`,
              q[0],
              q[1],
              q[0] + Math.cos(a) * headMm,
              q[1] + Math.sin(a) * headMm,
              amp * 0.5,
              dpi,
            );
          }
          break;
        }
        case 'circle': {
          const c = pts[0];
          const edge = pts[1];
          if (!c || !edge) break;
          const rMm = Math.hypot(edge[0] - c[0], edge[1] - c[1]);
          const steps = 48;
          ctx.beginPath();
          for (let i = 0; i <= steps; i++) {
            const t = (i / steps) * Math.PI * 2;
            const wob = randSigned(seed, 'circle', i, amp);
            const xMm = c[0] + Math.cos(t) * (rMm + wob);
            const yMm = c[1] + Math.sin(t) * (rMm + wob);
            const x = mmToPx(xMm, dpi);
            const y = mmToPx(yMm, dpi);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          break;
        }
        case 'label':
          // Labels are glyph runs and belong to paint, which already drew them from
          // `figure.label`. Nothing to stroke here.
          break;
      }
    }

    ctx.restore();
  }
}
