/**
 * Every seam in the client, declared in one place. FROZEN with the seam-freeze commit.
 *
 * A strand implements one of these interfaces and registers it. No strand modifies
 * kernel.ts. A strand that believes it must is reporting a contract bug to the lead,
 * and the lead amends this file on `dev` and re-bases everyone (plan §3).
 */

import type { Block, Document, Delta, Problem, Snapshot, Style } from '../types/document';
import type {
  DocumentGeometry,
  GlyphMetricsProvider,
  GlyphOutlineProvider,
  PageGeometry,
} from '../render/geometry';
import type { Mm, RectMm } from '../render/units';

/** The three canvas layers of one page. Paper never repaints; that is what makes G1 reachable. */
export interface PageLayers {
  readonly pageIndex: number;
  /** Static procedural paper. Repainted only when style or DPI changes. */
  readonly paper: HTMLCanvasElement;
  /** Ink. Repainted per dirty rect. */
  readonly ink: HTMLCanvasElement;
  /**
   * Badges, selection, lasso. NEVER composited into export (plan §C.5.4) — export is
   * blocked instead while a problem badge exists, because printing a red error badge
   * onto submitted work and silently dropping the overflow warning are both wrong.
   */
  readonly overlay: HTMLCanvasElement;
  readonly dpi: number;
}

export interface LayoutEngine {
  readonly name: string;
  layout(doc: Document, style: Style, metrics: GlyphMetricsProvider): DocumentGeometry;
}

export interface PaintEngine {
  readonly name: string;
  /**
   * Paint the ink layer. `dirtyMm` restricts work to a rectangle; undefined means the
   * whole page. Invariant I7: cost is O(dirty area), never O(strokes).
   */
  paintInk(
    layers: PageLayers,
    page: PageGeometry,
    style: Style,
    outlines: GlyphOutlineProvider,
    dirtyMm?: RectMm,
  ): void;
}

export interface PaperEngine {
  readonly name: string;
  /** Cached per (params, dpi, seed). Gate G4: <=1200 ms cold, <=5 ms warm. */
  paintPaper(layers: PageLayers, style: Style): void;
}

export interface FiguresRenderer {
  readonly name: string;
  paintFigures(layers: PageLayers, page: PageGeometry, style: Style): void;
}

export interface GlyphProfileProvider {
  readonly name: string;
  load(profileId: string): Promise<{
    metrics: GlyphMetricsProvider;
    outlines: GlyphOutlineProvider;
  }>;
}

export interface ExportController {
  readonly name: string;
  /** Rejects if any block carries a problem badge (plan §C.5.4). */
  exportPdf(opts: { dpi: number }): Promise<{ path: string }>;
  readonly canExport: boolean;
}

export interface ChatPanel {
  readonly name: string;
  mount(host: HTMLElement): void;
  /** The selection is the unit of conversation — §B.2's #1 differentiator. */
  askAboutSelection(blockIds: readonly string[], question: string): Promise<void>;
}

export interface StylePanel {
  readonly name: string;
  mount(host: HTMLElement): void;
}

export interface LassoController {
  readonly name: string;
  mount(host: HTMLElement): void;
  /**
   * Hand the controller the current geometry so it can index it.
   *
   * AMENDED 2026-09-17 by the lead. The original interface had `hitTest` and no way to
   * receive anything to hit-test AGAINST, so a correct implementation would build an
   * empty index and silently select nothing on every gesture — a failure with no error
   * and no log line. The seam-freeze covered the shape of the call and not the flow of
   * data into it, which is the same gap that cost this project three integration
   * defects in the previous wave.
   */
  setGeometry(geometry: DocumentGeometry | null): void;
  /** Gate G15: <=2 ms per pointermove on a 20-page document. Needs a spatial index. */
  hitTest(xMm: Mm, yMm: Mm, pageIndex: number): string | null;
  hitTestRect(rect: RectMm, pageIndex: number): readonly string[];
}

/** The transport. One implementation talks to the local server; the stub talks to nothing. */
export interface ProtocolClient {
  readonly name: string;
  connect(): Promise<void>;
  snapshot(): Promise<Snapshot>;
  sendDelta(delta: Delta): Promise<void>;
  onRemoteDelta(handler: (d: Delta) => void): void;
  onDisconnect(handler: (reason: string) => void): void;
  readonly connected: boolean;
}

export interface SelectionModel {
  readonly blockIds: readonly string[];
  set(ids: readonly string[]): void;
  clear(): void;
  onChange(handler: (ids: readonly string[]) => void): void;
}

export interface ProblemSink {
  raise(p: Problem): void;
  clearBlock(blockId: string): void;
  readonly all: readonly Problem[];
  onChange(handler: (all: readonly Problem[]) => void): void;
}

export interface Scheduler {
  /** Mark a block dirty. Coalesced to one repaint per frame. */
  invalidateBlock(blockId: string): void;
  invalidatePage(pageIndex: number): void;
  invalidateAll(): void;
  readonly pendingPages: readonly number[];
}

export type { Block, Document, Delta, Problem, Snapshot, Style };
