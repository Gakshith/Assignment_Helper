/**
 * Seam-freeze stubs. Every subsystem, wired and registered, returning valid empty data.
 *
 * These exist so kernel.ts could be finished and CLOSED before any fan-out (plan §3).
 * Each one is replaced wholesale by a strand's real implementation; none is edited in
 * place, and kernel.ts never changes when one is swapped.
 *
 * A stub is allowed to render nothing. It is NOT allowed to lie: a stub that cannot do
 * its job raises a Problem like the real thing would, because a silently-empty page
 * during integration is the exact failure the seam-freeze exists to prevent.
 */

import type {
  ChatPanel,
  ExportController,
  FiguresRenderer,
  GlyphProfileProvider,
  LassoController,
  LayoutEngine,
  PageLayers,
  PaintEngine,
  PaperEngine,
  ProblemSink,
  ProtocolClient,
  StylePanel,
  Delta,
  Document,
  Snapshot,
  Style,
} from '../contracts';
import type {
  DocumentGeometry,
  GlyphMetricsProvider,
  GlyphOutlineProvider,
  PageGeometry,
} from '../../render/geometry';
import { PAGE_SIZES, mmToPx, type Mm, type RectMm } from '../../render/units';

export const stubMetrics: GlyphMetricsProvider = {
  profileId: 'stub',
  has: () => true,
  advanceMm: (_ch, sizeMm) => sizeMm * 0.55,
  ascentMm: (_ch, sizeMm) => sizeMm * 0.75,
  descentMm: (_ch, sizeMm) => sizeMm * 0.25,
  variantCount: () => 1,
  substitute: () => null,
};

export const stubOutlines: GlyphOutlineProvider = {
  profileId: 'stub',
  unitsPerEm: 1000,
  outline: () => null,
};

export const stubLayout: LayoutEngine = {
  name: 'stub-layout',
  layout(_doc: Document, style: Style): DocumentGeometry {
    const size = PAGE_SIZES[style.paper?.page_size ?? 'letter'];
    const page: PageGeometry = {
      pageIndex: 0,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      blocks: [],
    };
    return { docVersion: -1, styleHash: 'stub', pages: [page] };
  },
};

export const stubPaint: PaintEngine = {
  name: 'stub-paint',
  paintInk(layers: PageLayers, page: PageGeometry, _style: Style, _o: GlyphOutlineProvider, dirty?: RectMm) {
    const ctx = layers.ink.getContext('2d');
    if (!ctx) throw new Error('stub-paint: no 2d context on the ink layer');
    const r = dirty ?? { xMm: 0, yMm: 0, wMm: page.widthMm, hMm: page.heightMm };
    ctx.clearRect(
      mmToPx(r.xMm, layers.dpi),
      mmToPx(r.yMm, layers.dpi),
      mmToPx(r.wMm, layers.dpi),
      mmToPx(r.hMm, layers.dpi),
    );
    ctx.fillStyle = 'rgba(120,120,120,0.28)';
    for (const b of page.blocks) {
      ctx.fillRect(
        mmToPx(b.boxMm.xMm, layers.dpi),
        mmToPx(b.boxMm.yMm, layers.dpi),
        mmToPx(b.boxMm.wMm, layers.dpi),
        mmToPx(b.boxMm.hMm, layers.dpi),
      );
    }
  },
};

export const stubPaper: PaperEngine = {
  name: 'stub-paper',
  paintPaper(layers: PageLayers, style: Style) {
    const ctx = layers.paper.getContext('2d');
    if (!ctx) throw new Error('stub-paper: no 2d context on the paper layer');
    ctx.fillStyle = style.paper?.tint ?? '#F4F1E9';
    ctx.fillRect(0, 0, layers.paper.width, layers.paper.height);
  },
};

export const stubFigures: FiguresRenderer = {
  name: 'stub-figures',
  paintFigures() {
    /* no figures until the figures strand lands */
  },
};

export const stubGlyphs: GlyphProfileProvider = {
  name: 'stub-glyphs',
  async load() {
    return { metrics: stubMetrics, outlines: stubOutlines };
  },
};

/** Talks to nothing and says so. Replaced by the real WS/HTTP client. */
export function makeStubProtocol(doc: Document): ProtocolClient {
  let connected = false;
  return {
    name: 'stub-protocol',
    async connect() {
      connected = true;
    },
    async snapshot(): Promise<Snapshot> {
      return { version: 0, document: doc };
    },
    async sendDelta(_d: Delta) {
      throw new Error('stub-protocol cannot send deltas; the server strand has not landed');
    },
    onRemoteDelta() {},
    onDisconnect() {},
    get connected() {
      return connected;
    },
  };
}

export function makeStubExport(problems: ProblemSink): ExportController {
  return {
    name: 'stub-export',
    canExport: true,
    attach() {},
    async exportPdf() {
      problems.raise({
        scope: 'app',
        code: 'export.stub',
        message: 'Export is not built yet.',
        detail: 'stub-export',
      });
      throw new Error('stub-export produces no PDF');
    },
  };
}

export const stubChat: ChatPanel = {
  name: 'stub-chat',
  mount(host: HTMLElement) {
    host.textContent = 'chat — not built';
  },
  async askAboutSelection(blockIds, question) {
    console.info('[stub-chat] echo', blockIds, question);
  },
};

export const stubStylePanel: StylePanel = {
  name: 'stub-style-panel',
  mount(host: HTMLElement) {
    host.textContent = 'style — not built';
  },
};

export const stubLasso: LassoController = {
  name: 'stub-lasso',
  mount() {},
  setGeometry() {},
  hitTest(_x: Mm, _y: Mm) {
    return null;
  },
  hitTestRect() {
    return [];
  },
};
