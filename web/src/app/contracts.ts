/**
 * Every seam in the client, declared in one place. FROZEN with the seam-freeze commit.
 *
 * A strand implements one of these interfaces and registers it. No strand modifies
 * kernel.ts. A strand that believes it must is reporting a contract bug to the lead,
 * and the lead amends this file on `dev` and re-bases everyone (plan §3).
 */

import type { Block, Document, Delta, Op, Problem, Snapshot, Style } from '../types/document';
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

/**
 * Everything export needs from the running app. AMENDED 2026-09-18.
 *
 * `exportPdf({ dpi })` was handed a number and nothing else, so a correct
 * implementation had no geometry to paint, no engines to paint it with, and no way to
 * know whether §C.5.4's export block was in force. Third instance of the same gap: the
 * freeze fixed the signature of a call and not the flow of data into it.
 *
 * Invariant I11 lives here in the shape of the interface: export is given GEOMETRY and
 * the paint engines, never a preview bitmap, so it cannot upscale the screen even by
 * mistake.
 */
export interface ExportSources {
  geometry(): DocumentGeometry | null;
  style(): Style | null;
  outlines(): GlyphOutlineProvider | null;
  readonly paint: PaintEngine;
  readonly paper: PaperEngine;
  readonly figures: FiguresRenderer;
  documentPath(): string | null;
  title(): string;
  /** §C.5.4: export is BLOCKED while any block carries a problem badge. */
  blockedBlockIds(): readonly string[];
}

export interface ExportController {
  readonly name: string;
  /** Called once by the kernel at startup. */
  attach(sources: ExportSources): void;
  /** Rejects if any block carries a problem badge (plan §C.5.4). */
  exportPdf(opts: { dpi: number }): Promise<{ path: string }>;
  readonly canExport: boolean;
}

/**
 * What a UI subsystem is allowed to DO to the document. AMENDED 2026-09-18.
 *
 * Before this existed, `LassoController.mount(host)` received a DOM node and nothing
 * else — so a correct implementation could detect a selection and had no way to report
 * it, and the four-action toolbar had no way to act. The lasso shipped with
 * `onSelect: () => {}` and was inert. Same gap as `setGeometry`: the freeze fixed the
 * shape of a call and not the flow of data through it.
 *
 * Everything here goes through the server (invariant I4). Nothing mutates the local
 * document and hopes.
 */
export interface EditorActions {
  readonly selection: SelectionModel;

  /** New seeds for these blocks — the same words in a differently imperfect hand. */
  reroll(blockIds: readonly string[], scale: RerollScale): Promise<void>;

  /** Replace one block's text (prose) or LaTeX (math). One undo step. */
  editBlock(blockId: string, text: string): Promise<void>;

  setStyle(style: Style): Promise<void>;

  /** Every AI edit and every user edit is exactly one undo step (acceptance row 19). */
  undo(): Promise<void>;
  redo(): Promise<void>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  onHistoryChange(handler: () => void): void;

  /**
   * The toolbar's "Ask" pill. The chat panel subscribes; the lasso publishes. Routing
   * it through here rather than letting the lasso reach for the chat panel keeps the
   * two UI strands from importing each other.
   */
  requestAsk(blockIds: readonly string[]): void;
  onAskRequested(handler: (blockIds: readonly string[]) => void): void;
}

/** Re-roll at three scales — plan §C.1's M4 wording, made concrete. */
export type RerollScale = 'block' | 'page' | 'document';

export interface ChatPanel {
  readonly name: string;
  mount(host: HTMLElement, actions: EditorActions): void;
  /** The selection is the unit of conversation — §B.2's #1 differentiator. */
  askAboutSelection(blockIds: readonly string[], question: string): Promise<void>;
}

export interface StylePanel {
  readonly name: string;
  mount(host: HTMLElement, actions?: EditorActions): void;
}

export interface LassoController {
  readonly name: string;
  mount(host: HTMLElement, actions: EditorActions): void;
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

export type { Block, Document, Delta, Op, Problem, Snapshot, Style };
