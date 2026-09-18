/**
 * The browser half of export: geometry -> pixels at export DPI -> raw RGBA to the
 * local server, one page at a time.
 *
 * **Invariant I11 — export never reads the screen.** It re-PAINTS from geometry at
 * export DPI. It does not upscale the preview, and it does not re-run layout either:
 * geometry is computed once at no DPI, and re-running it here would recreate exactly
 * the divergence gate G16 exists to catch.
 *
 * **§C.5.4 — the overlay layer is never composited.** Only paper and ink reach the PDF.
 * Export is refused outright while any block carries a problem badge, because the two
 * alternatives are both wrong: printing a red error badge onto submitted work, or
 * silently dropping the visible-overflow warning from the one artifact that matters.
 *
 * One page at a time, on the main thread. The plan specified a Worker with
 * OffscreenCanvas for parallelism; this is the smaller thing that is correct, and it
 * keeps peak memory at one page (~33 MB at 300 DPI Letter) instead of N. If G6 misses,
 * the fallback is a Worker — but a fallback that is only needed after measurement.
 */

import type { ExportController, ExportSources, PageLayers } from '../app/contracts';
import { mmToPx } from '../render/units';
import { runReadbackSelfTest, type ReadbackCanvas } from './readback';
import {
  PAGE_HEADERS,
  TOKEN_HEADER,
  type BeginResponse,
  type FinishResponse,
  type PageResponse,
} from './wire';

/** Invariant I6: per-page rasterize timeout. Abort the ENTIRE export, never resume. */
const PAGE_TIMEOUT_MS = 20_000;

export class ExportBlocked extends Error {
  readonly blockIds: readonly string[];
  constructor(blockIds: readonly string[]) {
    super(
      `Export is blocked: ${blockIds.length} block(s) carry a problem badge ` +
        `(${blockIds.join(', ')}). Fix or remove them first — a badge must never print ` +
        `onto submitted work, and dropping it silently would hide the warning.`,
    );
    this.name = 'ExportBlocked';
    this.blockIds = blockIds;
  }
}

function detachedLayers(wPx: number, hPx: number, dpi: number): PageLayers {
  const make = (): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = wPx;
    c.height = hPx;
    return c;
  };
  // The overlay exists because PageLayers requires it. It is created and NEVER drawn
  // into and NEVER composited — see §C.5.4 above.
  return { pageIndex: 0, paper: make(), ink: make(), overlay: make(), dpi };
}

export class BrowserExportController implements ExportController {
  readonly name = 'export';
  #sources: ExportSources | null = null;
  #readbackOk: boolean | null = null;
  #running = false;

  constructor(private readonly token: string | null) {}

  attach(sources: ExportSources): void {
    this.#sources = sources;
  }

  get canExport(): boolean {
    if (!this.#sources) return false;
    if (this.#readbackOk === false) return false;
    // Acceptance row 13: never start an export the tab cannot finish.
    if (typeof document !== 'undefined' && document.hidden) return false;
    return this.#sources.blockedBlockIds().length === 0;
  }

  /**
   * Timings from the LAST export, for the gate harness.
   *
   * `receiveMs` and `artifactMs` are the SERVER'S OWN measurements, carried back in
   * the wire responses — G7 and G8 are about what the server did, and a client-side
   * stopwatch around a fetch would include the browser's queueing and report a number
   * about the browser instead.
   */
  lastTimings: {
    rasterMs: number[];
    receiveMs: number[];
    artifactMs: readonly number[];
    pageBytes: readonly number[];
  } = { rasterMs: [], receiveMs: [], artifactMs: [], pageBytes: [] };

  async exportPdf(opts: { dpi: number }): Promise<{ path: string }> {
    const sources = this.#sources;
    if (!sources) throw new Error('export: attach() was never called by the kernel');
    if (this.#running) throw new Error('export: an export is already running');

    const blocked = sources.blockedBlockIds();
    if (blocked.length > 0) throw new ExportBlocked(blocked);

    // I12 / acceptance row 12. Runs once, and a failure keeps export disabled while
    // leaving preview working — a corrupted PDF is far worse than a refusal.
    if (this.#readbackOk === null) {
      try {
        runReadbackSelfTest((w, h) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = h;
          return c satisfies ReadbackCanvas;
        });
        this.#readbackOk = true;
      } catch (err) {
        this.#readbackOk = false;
        throw err;
      }
    }

    const geometry = sources.geometry();
    const style = sources.style();
    const outlines = sources.outlines();
    if (!geometry || !style || !outlines) {
      throw new Error('export: the document has not finished loading');
    }

    const dpi = opts.dpi;
    const first = geometry.pages[0];
    if (!first) throw new Error('export: the document has no pages');
    const wPx = Math.round(mmToPx(first.widthMm, dpi));
    const hPx = Math.round(mmToPx(first.heightMm, dpi));

    this.#running = true;
    this.lastTimings = { rasterMs: [], receiveMs: [], artifactMs: [], pageBytes: [] };
    let sessionId: string | null = null;
    try {
      const begin = (await this.#post('/api/export/begin', {
        dpi,
        page_count: geometry.pages.length,
        page_w_px: wPx,
        page_h_px: hPx,
        document_path: sources.documentPath(),
        title: sources.title(),
        seed: 0,
        blocked_block_ids: [],
      })) as BeginResponse;
      sessionId = begin.session_id;

      for (const page of geometry.pages) {
        // G6 is the rasterize alone: paint into detached canvases and composite. The
        // POST is measured separately, because bundling them would hide which half is
        // slow.
        const rasterStart = performance.now();
        const layers = detachedLayers(wPx, hPx, dpi);
        sources.paper.paintPaper(layers, style);
        sources.paint.paintInk(layers, page, style, outlines);
        sources.figures.paintFigures(layers, page, style);

        // Composite paper then ink. The overlay is not touched.
        const out = document.createElement('canvas');
        out.width = wPx;
        out.height = hPx;
        const ctx = out.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('export: no 2d context for the composite');
        ctx.drawImage(layers.paper, 0, 0);
        ctx.drawImage(layers.ink, 0, 0);

        const rgba = ctx.getImageData(0, 0, wPx, hPx).data;
        this.lastTimings.rasterMs.push(performance.now() - rasterStart);

        const pageResult = await this.#postPage(sessionId, page.pageIndex, wPx, hPx, rgba);
        if (pageResult) this.lastTimings.receiveMs.push(pageResult.receive_ms);
      }

      const finished = (await this.#post(
        `/api/export/finish/${sessionId}`,
        {},
      )) as FinishResponse;
      this.lastTimings.artifactMs = finished.artifact_ms ?? [];
      this.lastTimings.pageBytes = finished.page_bytes ?? [];
      return { path: finished.path };
    } catch (err) {
      // I6 / acceptance rows 11, 13, 14: abort the WHOLE export and let the server
      // delete the partial PDF. Never a half-PDF left on disk for someone to submit.
      if (sessionId) {
        try {
          await this.#post(`/api/export/abort/${sessionId}`, {});
        } catch (abortErr) {
          // Not swallowed: a failed abort may leave a partial file, and the user needs
          // to know that rather than believing the cleanup happened.
          console.error('export: abort failed; a partial file may remain', abortErr);
        }
      }
      throw err;
    } finally {
      this.#running = false;
    }
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (this.token) h[TOKEN_HEADER] = this.token;
    return h;
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(path, {
      method: 'POST',
      headers: this.#headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async #postPage(
    sessionId: string,
    index: number,
    wPx: number,
    hPx: number,
    rgba: Uint8ClampedArray,
  ): Promise<PageResponse | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/export/page/${sessionId}`, {
        method: 'POST',
        headers: this.#headers({
          'content-type': 'application/octet-stream',
          [PAGE_HEADERS.index]: String(index),
          [PAGE_HEADERS.width]: String(wPx),
          [PAGE_HEADERS.height]: String(hPx),
        }),
        // Raw pixels. Not base64, not JSON: 15 MB through a JSON encoder costs more on
        // its own than the whole of gate G7 (POST + decode <= 40 ms/page).
        body: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`page ${index} failed (${res.status}): ${await res.text()}`);
      }
      return (await res.json()) as PageResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}
