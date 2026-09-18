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

import type {
  ChatPanel,
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
import { PAGE_SIZES, mmToPx } from '../render/units';

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

  #geometry: DocumentGeometry | null = null;
  #metrics: GlyphMetricsProvider | null = null;
  #outlines: GlyphOutlineProvider | null = null;

  constructor(
    private readonly subsystems: KernelSubsystems,
    private readonly hosts: KernelHosts,
  ) {
    this.store = new DocumentStore(this.problems);
    this.scheduler = new KernelScheduler((blocks, pagesDirty, all) => this.#flush(blocks, pagesDirty, all));
  }

  /** Every seam connected, in one place, in one order. */
  async start(): Promise<void> {
    this.pages.mount(this.hosts.pages);
    this.subsystems.style.mount(this.hosts.rightPanel);
    this.subsystems.chat.mount(this.hosts.chatDock);
    this.subsystems.lasso.mount(this.hosts.pages);

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

    await this.subsystems.protocol.connect();
    const snap = await this.subsystems.protocol.snapshot();
    this.store.adoptSnapshot(snap.version, snap.document);

    const profileId = snap.document.style?.hand?.profile ?? 'reference';
    const hand = await this.subsystems.glyphs.load(profileId);
    this.#metrics = hand.metrics;
    this.#outlines = hand.outlines;

    this.scheduler.invalidateAll();
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

    if (all || this.#geometry === null || this.#geometry.docVersion !== this.store.version) {
      this.#geometry = this.subsystems.layout.layout(doc, style, this.#metrics);
      // The lasso indexes what it is given. Without this call its index is empty and
      // every gesture selects nothing, silently — see the note on setGeometry.
      this.subsystems.lasso.setGeometry(this.#geometry);
    }

    const sizeName = style.paper?.page_size ?? 'letter';
    const dpi = style.preview_dpi ?? 150;

    for (const page of this.#geometry.pages) {
      const touched =
        all ||
        dirtyPages.has(page.pageIndex) ||
        page.blocks.some((b) => dirtyBlocks.has(b.blockId));
      if (!touched) continue;

      const layers = this.pages.ensure(page.pageIndex, sizeName, dpi);
      if (all) this.subsystems.paper.paintPaper(layers, style);
      this.subsystems.paint.paintInk(layers, page, style, this.#outlines);
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
    return this.problems.all.every((p) => p.scope !== 'block');
  }
}
