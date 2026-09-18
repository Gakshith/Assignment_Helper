/**
 * THE CLIENT KERNEL. ***FROZEN.*** Do not modify on a strand branch.
 *
 * Plan §3, the seam-freeze. This is where the parallel strands converge: it owns the
 * document store, the version/delta protocol client, the render scheduler and dirty-rect
 * queue, the per-page canvas-layer registry, the selection model and the problem sink —
 * and it CONSTRUCTS AND REGISTERS every subsystem. Every one of those is something a
 * strand naturally wants to reach in and wire up, which is exactly why it is wired
 * completely against stubs BEFORE any fan-out and closed afterwards.
 *
 * A strand implements an interface from ./contracts.ts and is registered here through
 * the registry that already exists. A strand that believes it needs to edit this file is
 * reporting a contract bug to the lead; the lead amends the contract on `dev` and
 * re-bases everyone. Nobody edits it in place.
 *
 * Instrumentation lives HERE and only here: invariant I1 bans performance.now() under
 * render/**, and gates G1-G3 have to measure something.
 */

import { KernelActions } from './actions';
import type {
  ChatPanel,
  EditorActions,
  Delta,
  Document,
  ExportController,
  FiguresRenderer,
  GlyphProfileProvider,
  LassoController,
  LayoutEngine,
  PageLayers,
  PaintEngine,
  PaperEngine,
  Problem,
  ProblemSink,
  ProtocolClient,
  Scheduler,
  SelectionModel,
  Style,
  StylePanel,
} from './contracts';
import type { DocumentGeometry, GlyphMetricsProvider, GlyphOutlineProvider } from '../render/geometry';
import { PAGE_SIZES, mmToPx, rectUnion, type RectMm } from '../render/units';

// ---------------------------------------------------------------- problem sink

class KernelProblemSink implements ProblemSink {
  #problems: Problem[] = [];
  #handlers: ((all: readonly Problem[]) => void)[] = [];

  raise(p: Problem): void {
    this.#problems = [...this.#problems.filter((x) => !(x.code === p.code && x.block_id === p.block_id)), p];
    // Invariant I5: no silent failure. Everything that reaches here is also logged,
    // because a badge the user has scrolled past is not a record.
    console.error(`[problem:${p.scope}] ${p.code}: ${p.message}`, p.detail ?? '');
    this.#emit();
  }

  clearBlock(blockId: string): void {
    const before = this.#problems.length;
    this.#problems = this.#problems.filter((p) => p.block_id !== blockId);
    if (this.#problems.length !== before) this.#emit();
  }

  get all(): readonly Problem[] {
    return this.#problems;
  }

  onChange(handler: (all: readonly Problem[]) => void): void {
    this.#handlers.push(handler);
  }

  #emit(): void {
    for (const h of this.#handlers) h(this.#problems);
  }
}

// ---------------------------------------------------------------- document store

/**
 * Invariant I4: the SERVER document is authoritative. The client holds (version, doc).
 * A delta whose parentVersion !== client.version is rejected and the client asks for a
 * full snapshot. Never merge blindly, never reconcile heuristically.
 */
class DocumentStore {
  #version = 0;
  #doc: Document | null = null;
  #handlers: ((doc: Document, version: number) => void)[] = [];

  constructor(private readonly problems: ProblemSink) {}

  get version(): number {
    return this.#version;
  }

  get doc(): Document | null {
    return this.#doc;
  }

  get style(): Style | null {
    return this.#doc?.style ?? null;
  }

  adoptSnapshot(version: number, doc: Document): void {
    this.#version = version;
    this.#doc = doc;
    this.#emit();
  }

  /** Returns false when the delta was rejected — the caller must fetch a snapshot. */
  applyDelta(delta: Delta, next: Document, nextVersion: number): boolean {
    if (delta.parent_version !== this.#version) {
      this.problems.raise({
        scope: 'app',
        code: 'delta.parent-mismatch',
        message: 'The local document is out of step with the server; resyncing.',
        detail: `delta parent ${delta.parent_version}, local ${this.#version}`,
      });
      return false;
    }
    this.#version = nextVersion;
    this.#doc = next;
    this.#emit();
    return true;
  }

  onChange(handler: (doc: Document, version: number) => void): void {
    this.#handlers.push(handler);
  }

  #emit(): void {
    if (!this.#doc) return;
    for (const h of this.#handlers) h(this.#doc, this.#version);
  }
}

// ---------------------------------------------------------------- page registry

/**
 * Invariant I13: page DOM nodes are created ONCE per page and never replaced. Only
 * canvas contents change. This, not the delta protocol, is what preserves scroll, zoom
 * and text selection across an edit.
 */
class PageRegistry {
  #pages = new Map<number, PageLayers>();
  #host: HTMLElement | null = null;

  mount(host: HTMLElement): void {
    this.#host = host;
  }

  ensure(pageIndex: number, sizeName: keyof typeof PAGE_SIZES, dpi: number): PageLayers {
    const existing = this.#pages.get(pageIndex);
    if (existing && existing.dpi === dpi) return existing;

    const size = PAGE_SIZES[sizeName];
    const wPx = Math.round(mmToPx(size.widthMm, dpi));
    const hPx = Math.round(mmToPx(size.heightMm, dpi));

    if (existing) {
      // Same node, new backing store. I13 holds: we never replace the element.
      for (const c of [existing.paper, existing.ink, existing.overlay]) {
        c.width = wPx;
        c.height = hPx;
      }
      const relaid: PageLayers = { ...existing, dpi };
      this.#pages.set(pageIndex, relaid);
      return relaid;
    }

    const make = (cls: string): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.className = `page-layer page-layer--${cls}`;
      c.width = wPx;
      c.height = hPx;
      c.style.width = `${size.widthMm}mm`;
      c.style.height = `${size.heightMm}mm`;
      return c;
    };

    const wrapper = document.createElement('div');
    wrapper.className = 'page';
    wrapper.dataset['pageIndex'] = String(pageIndex);
    const layers: PageLayers = {
      pageIndex,
      paper: make('paper'),
      ink: make('ink'),
      overlay: make('overlay'),
      dpi,
    };
    wrapper.append(layers.paper, layers.ink, layers.overlay);
    this.#host?.append(wrapper);
    this.#pages.set(pageIndex, layers);
    return layers;
  }

  get(pageIndex: number): PageLayers | undefined {
    return this.#pages.get(pageIndex);
  }

  get count(): number {
    return this.#pages.size;
  }
}

// ---------------------------------------------------------------- selection

class KernelSelection implements SelectionModel {
  #ids: readonly string[] = [];
  #handlers: ((ids: readonly string[]) => void)[] = [];

  get blockIds(): readonly string[] {
    return this.#ids;
  }

  set(ids: readonly string[]): void {
    this.#ids = [...ids];
    for (const h of this.#handlers) h(this.#ids);
  }

  clear(): void {
    this.set([]);
  }

  onChange(handler: (ids: readonly string[]) => void): void {
    this.#handlers.push(handler);
  }
}

// ---------------------------------------------------------------- scheduler

/**
 * The dirty-rect queue. Coalesces to one repaint per animation frame.
 * Gates G1 (<=40 ms single block, no reflow) and G2 (<=120 ms with reflow) are
 * measured from here, because render/** may not call performance.now() (I1).
 */
class KernelScheduler implements Scheduler {
  #dirtyBlocks = new Set<string>();
  #dirtyPages = new Set<number>();
  #all = false;
  #frame: number | null = null;
  #markT0 = 0;

  constructor(private readonly flush: (dirtyBlocks: ReadonlySet<string>, dirtyPages: ReadonlySet<number>, all: boolean) => void) {}

  invalidateBlock(blockId: string): void {
    this.#dirtyBlocks.add(blockId);
    this.#schedule();
  }

  invalidatePage(pageIndex: number): void {
    this.#dirtyPages.add(pageIndex);
    this.#schedule();
  }

  invalidateAll(): void {
    this.#all = true;
    this.#schedule();
  }

  get pendingPages(): readonly number[] {
    return [...this.#dirtyPages];
  }

  /** The measured duration of the last flush, in ms. Read by the perf harness. */
  lastFlushMs = 0;

  #schedule(): void {
    if (this.#frame !== null) return;
    this.#markT0 = performance.now();
    this.#frame = requestAnimationFrame(() => {
      this.#frame = null;
      const blocks = this.#dirtyBlocks;
      const pages = this.#dirtyPages;
      const all = this.#all;
      this.#dirtyBlocks = new Set();
      this.#dirtyPages = new Set();
      this.#all = false;
      this.flush(blocks, pages, all);
      this.lastFlushMs = performance.now() - this.#markT0;
    });
  }
}

// ---------------------------------------------------------------- the kernel

export interface KernelSubsystems {
  layout: LayoutEngine;
  paint: PaintEngine;
  paper: PaperEngine;
  figures: FiguresRenderer;
  glyphs: GlyphProfileProvider;
  protocol: ProtocolClient;
  exporter: ExportController;
  chat: ChatPanel;
  style: StylePanel;
  lasso: LassoController;
}

export interface KernelHosts {
  pages: HTMLElement;
  rightPanel: HTMLElement;
  chatDock: HTMLElement;
}

export class Kernel {
  readonly problems: ProblemSink = new KernelProblemSink();
  readonly selection: SelectionModel = new KernelSelection();
  readonly store: DocumentStore;
  readonly pages = new PageRegistry();
  readonly scheduler: KernelScheduler;

  /**
   * The editor's verbs. Handed to every UI subsystem at mount, because a subsystem that
   * can detect an intent and cannot act on it is inert — which is exactly what happened
   * to the lasso before this existed.
   */
  readonly actions: EditorActions;

  #geometry: DocumentGeometry | null = null;
  /**
   * The document version and style the cached geometry was computed FOR.
   *
   * Tracked here rather than read off `geometry.docVersion`, which the layout engine
   * cannot fill in: `layout(doc, style, metrics)` is handed a Document, and a version
   * belongs to a Snapshot, not to a Document. The engine emitted a placeholder -1, so
   * the kernel's cache check was always true and EVERY repaint re-laid out the whole
   * document — including a single-block edit. The symptom was G1 and G3 measuring the
   * same, which a single-block repaint never legitimately does.
   */
  #geometryVersion: number | null = null;
  #geometryStyleHash: string | null = null;
  #metrics: GlyphMetricsProvider | null = null;
  #outlines: GlyphOutlineProvider | null = null;

  constructor(
    private readonly subsystems: KernelSubsystems,
    private readonly hosts: KernelHosts,
  ) {
    this.store = new DocumentStore(this.problems);
    this.scheduler = new KernelScheduler((blocks, pagesDirty, all) => this.#flush(blocks, pagesDirty, all));
    this.actions = new KernelActions({
      selection: this.selection,
      problems: this.problems,
      protocol: subsystems.protocol,
      currentDoc: () => this.store.doc,
      currentVersion: () => this.store.version,
      resync: async () => {
        const snap = await subsystems.protocol.snapshot();
        this.store.adoptSnapshot(snap.version, snap.document);
      },
      headers: (extra = {}) => {
        const h: Record<string, string> = { ...extra };
        let token: string | null = null;
        try {
          token = sessionStorage.getItem('ah.token');
        } catch {
          token = null;
        }
        if (token) h['x-ah-token'] = token;
        return h;
      },
    });
  }

  /** Every seam connected, in one place, in one order. */
  async start(): Promise<void> {
    this.#bindShortcuts();
    this.pages.mount(this.hosts.pages);
    this.subsystems.style.mount(this.hosts.rightPanel, this.actions);
    this.subsystems.chat.mount(this.hosts.chatDock, this.actions);
    this.subsystems.lasso.mount(this.hosts.pages, this.actions);

    this.store.onChange(() => this.scheduler.invalidateAll());
    this.selection.onChange(() => this.scheduler.invalidateAll());

    this.subsystems.protocol.onRemoteDelta((d) => this.#onRemoteDelta(d));
    this.subsystems.protocol.onDisconnect((reason) =>
      this.problems.raise({
        scope: 'app',
        code: 'server.disconnected',
        message: 'Disconnected from the local server. Editing is disabled.',
        detail: reason,
      }),
    );

    this.subsystems.exporter.attach({
      geometry: () => this.#geometry,
      style: () => this.store.style,
      outlines: () => this.#outlines,
      paint: this.subsystems.paint,
      paper: this.subsystems.paper,
      figures: this.subsystems.figures,
      documentPath: () => this.store.doc?.source_path ?? null,
      title: () => this.store.doc?.title ?? 'assignment',
      blockedBlockIds: () =>
        this.problems.all.filter((p) => p.scope === 'block' && p.block_id).map((p) => p.block_id!),
    });

    await this.subsystems.protocol.connect();
    const snap = await this.subsystems.protocol.snapshot();
    this.store.adoptSnapshot(snap.version, snap.document);

    const profileId = snap.document.style?.hand?.profile ?? 'reference';
    const hand = await this.subsystems.glyphs.load(profileId);
    this.#metrics = hand.metrics;
    this.#outlines = hand.outlines;

    this.scheduler.invalidateAll();

    /**
     * Handshake with the chrome, which is a SECOND module entry (see ui/shell/index.ts:
     * it is bootstrapped separately so that a chrome failure does not take down the
     * app, and an app failure still has a banner to report itself in).
     *
     * An event rather than a shared import, because the two entries have no ordering
     * guarantee: whichever loads second must still be able to connect. Errors continue
     * to travel through the problem sink — this is a wiring signal, not a second error
     * path.
     */
    globalThis.dispatchEvent(new CustomEvent('ah:kernel-ready', { detail: this }));
  }

  /**
   * Undo/redo, bound once at the document level rather than on any one panel.
   *
   * The kernel owns it because undo is not a property of the surface you happened to
   * be looking at — a user who just accepted an AI edit expects Cmd+Z to take it back
   * whether the focus is on the page, the style panel or the chat box.
   */
  #bindShortcuts(): void {
    document.addEventListener('keydown', (ev) => {
      const accel = ev.metaKey || ev.ctrlKey;
      if (!accel || ev.key.toLowerCase() !== 'z') return;
      // Never steal the browser's own undo from a field the user is typing in.
      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      ev.preventDefault();
      void (ev.shiftKey ? this.actions.redo() : this.actions.undo());
    });
  }

  async #onRemoteDelta(delta: Delta): Promise<void> {
    // The kernel does not apply ops itself — the server is authoritative (I4), so a
    // remote delta is followed by re-reading the server's version of the truth.
    const snap = await this.subsystems.protocol.snapshot();
    if (!this.store.applyDelta(delta, snap.document, snap.version)) {
      this.store.adoptSnapshot(snap.version, snap.document);
    }
  }

  #flush(dirtyBlocks: ReadonlySet<string>, dirtyPages: ReadonlySet<number>, all: boolean): void {
    const doc = this.store.doc;
    const style = this.store.style;
    if (!doc || !style || !this.#metrics || !this.#outlines) return;

    const styleKey = JSON.stringify(style);
    const stale =
      this.#geometry === null ||
      this.#geometryVersion !== this.store.version ||
      this.#geometryStyleHash !== styleKey;
    if (stale) {
      this.#geometry = this.subsystems.layout.layout(doc, style, this.#metrics);
      this.#geometryVersion = this.store.version;
      this.#geometryStyleHash = styleKey;
      // The lasso indexes what it is given. Without this call its index is empty and
      // every gesture selects nothing, silently — see the note on setGeometry.
      this.subsystems.lasso.setGeometry(this.#geometry);
    }

    const sizeName = style.paper?.page_size ?? 'letter';
    const dpi = style.preview_dpi ?? 150;

    const geometry = this.#geometry;
    if (!geometry) return;

    for (const page of geometry.pages) {
      const touched =
        all ||
        dirtyPages.has(page.pageIndex) ||
        page.blocks.some((b) => dirtyBlocks.has(b.blockId));
      if (!touched) continue;

      const layers = this.pages.ensure(page.pageIndex, sizeName, dpi);
      if (all) this.subsystems.paper.paintPaper(layers, style);

      /**
       * Invariant I7: repaint cost is O(dirty area), never O(strokes).
       *
       * This passed `undefined` for the dirty rect, so every single-block edit repainted
       * the WHOLE page's ink. It measured fine — G1 23.7 ms against a 40 ms budget — on
       * a one-page document, and the tell was that G1 and G3 came out equal: a
       * single-block repaint cannot legitimately cost the same as a full page. On a
       * dense 20-page document it would blow the budget on every keystroke, and the
       * gate would have caught it far too late to be cheap to fix.
       *
       * The union of the dirty blocks' boxes is the rectangle; a page-scope or
       * whole-document invalidation still repaints everything, as it should.
       */
      let dirtyMm: RectMm | undefined;
      if (!all && !dirtyPages.has(page.pageIndex)) {
        for (const b of page.blocks) {
          if (!dirtyBlocks.has(b.blockId)) continue;
          dirtyMm = dirtyMm ? rectUnion(dirtyMm, b.boxMm) : b.boxMm;
        }
      }
      this.subsystems.paint.paintInk(layers, page, style, this.#outlines, dirtyMm);
      this.subsystems.figures.paintFigures(layers, page, style);

      for (const b of page.blocks) {
        if (b.problem) {
          this.problems.raise({
            scope: 'block',
            code: b.problem.code,
            message: b.problem.message,
            block_id: b.blockId,
          });
        } else {
          this.problems.clearBlock(b.blockId);
        }
      }
    }
  }

  get geometry(): DocumentGeometry | null {
    return this.#geometry;
  }

  /** §C.5.4: export is refused while any block carries a problem badge. */
  get canExport(): boolean {
    return this.problems.all.every((p) => p.scope !== 'block') && this.subsystems.exporter.canExport;
  }

  /**
   * The one public entry point for producing a PDF. The UI calls this rather than
   * reaching for the export controller, so the refusal rule and the problem reporting
   * live in one place instead of in every button that wants to export.
   */
  async exportPdf(dpi?: number): Promise<{ path: string } | null> {
    const target = dpi ?? this.store.style?.export_dpi ?? 200;
    try {
      return await this.subsystems.exporter.exportPdf({ dpi: target });
    } catch (err) {
      this.problems.raise({
        scope: 'app',
        code: 'export.failed',
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
