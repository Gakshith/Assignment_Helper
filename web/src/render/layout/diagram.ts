/**
 * The diagram spec, which the plan described only as "Diagram (declarative spec)".
 *
 * Defined here because it had to be defined somewhere, and the shape follows from the
 * two things it sits between: what a physics problem actually needs to draw, and what
 * `FigureGeometry` can carry.
 *
 * **Coordinates are millimetres relative to the block's own top-left**, not to the
 * page. A diagram that stored page coordinates would move when a paragraph above it
 * grew by a line, which is the one thing reflow must never do to a figure.
 *
 * ```json
 * [
 *   {"kind": "line",   "points": [[0,0],[40,20]]},
 *   {"kind": "arrow",  "points": [[0,0],[30,0]]},
 *   {"kind": "circle", "center": [20,20], "r": 8},
 *   {"kind": "rect",   "at": [5,5], "w": 30, "h": 12},
 *   {"kind": "axis",   "points": [[0,30],[50,30]]},
 *   {"kind": "label",  "at": [22,18], "text": "m"}
 * ]
 * ```
 */

import type { FigureGeometry } from '../geometry';
import type { Mm } from '../units';

export type DiagramPrimitive =
  | { kind: 'line' | 'arrow' | 'axis'; points: [number, number][] }
  | { kind: 'circle'; center: [number, number]; r: number }
  | { kind: 'rect'; at: [number, number]; w: number; h: number }
  | { kind: 'label'; at: [number, number]; text: string };

export interface DiagramLabel {
  readonly text: string;
  readonly xMm: Mm;
  readonly yMm: Mm;
}

export interface CompiledDiagram {
  readonly figures: readonly FigureGeometry[];
  readonly labels: readonly DiagramLabel[];
  readonly problems: readonly { code: string; message: string }[];
}

function pt(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = Number(v[0]);
  const y = Number(v[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/**
 * Spec -> figures in PAGE coordinates, plus the labels layout must set as text.
 *
 * Anything unrecognised becomes a Problem rather than being skipped: a diagram that
 * silently drops the one arrow that carried the meaning still looks like a diagram.
 */
export function compileDiagram(
  spec: readonly unknown[],
  originXMm: Mm,
  originYMm: Mm,
  blockId: string,
): CompiledDiagram {
  const figures: FigureGeometry[] = [];
  const labels: DiagramLabel[] = [];
  const problems: { code: string; message: string }[] = [];

  const shift = (p: [number, number]): readonly [Mm, Mm] =>
    [originXMm + p[0], originYMm + p[1]] as const;

  spec.forEach((rawEntry, i) => {
    const entry = rawEntry as Partial<DiagramPrimitive> & Record<string, unknown>;
    const kind = entry?.kind;
    const seed = `${blockId}:fig:${i}`;

    switch (kind) {
      case 'line':
      case 'arrow':
      case 'axis': {
        const pts = Array.isArray(entry['points'])
          ? (entry['points'] as unknown[]).map(pt).filter((p): p is [number, number] => p !== null)
          : [];
        if (pts.length < 2) {
          problems.push({
            code: 'diagram.bad-primitive',
            message: `A ${kind} at index ${i} needs at least two points.`,
          });
          return;
        }
        figures.push({ kind, pointsMm: pts.map(shift), seed });
        return;
      }
      case 'circle': {
        const c = pt(entry['center']);
        const r = Number(entry['r']);
        if (!c || !Number.isFinite(r) || r <= 0) {
          problems.push({
            code: 'diagram.bad-primitive',
            message: `A circle at index ${i} needs a centre and a positive radius.`,
          });
          return;
        }
        // The renderer reads point 0 as the centre and point 1 as a point on the rim.
        figures.push({ kind: 'circle', pointsMm: [shift(c), shift([c[0] + r, c[1]])], seed });
        return;
      }
      case 'rect': {
        const at = pt(entry['at']);
        const w = Number(entry['w']);
        const h = Number(entry['h']);
        if (!at || !Number.isFinite(w) || !Number.isFinite(h)) {
          problems.push({
            code: 'diagram.bad-primitive',
            message: `A rect at index ${i} needs an origin, a width and a height.`,
          });
          return;
        }
        figures.push({ kind: 'rect', pointsMm: [shift(at), shift([at[0] + w, at[1] + h])], seed });
        return;
      }
      case 'label': {
        const at = pt(entry['at']);
        const text = typeof entry['text'] === 'string' ? entry['text'] : '';
        if (!at || !text) {
          problems.push({
            code: 'diagram.bad-primitive',
            message: `A label at index ${i} needs a position and non-empty text.`,
          });
          return;
        }
        labels.push({ text, xMm: originXMm + at[0], yMm: originYMm + at[1] });
        return;
      }
      default:
        problems.push({
          code: 'diagram.unknown-primitive',
          message: `Unknown diagram primitive ${JSON.stringify(kind)} at index ${i}.`,
        });
    }
  });

  return { figures, labels, problems };
}
