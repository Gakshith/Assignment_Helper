/**
 * The export-side gates, measured in one real export.
 *
 *   node tests/perf/export_gates.mjs "<tokenised url>"
 *
 * G6  worker rasterize, one page            <= 900 ms
 * G7  raw RGBA POST + decode, one page      <= 40 ms   (the server times this itself)
 * G8  Python artifact pipeline, one page    <= 2.5 s   (ditto)
 * G9  full export, 20 pages                 <= 90 s
 * G10 PDF size                              <= 700 KB/page, warning not gate
 * G11 peak browser memory during export     <= 1.2 GB
 *
 * G7 and G8 are the server's OWN timings, carried back in the wire responses, rather
 * than wall clock measured from here — a client-side stopwatch around a fetch includes
 * the browser's own queueing and would report a number about the browser.
 *
 * The Python-side half of G11 (RSS <= 2.0 GB) is NOT measured: it needs psutil
 * sampling inside the server process, which is not built. It says so rather than
 * reporting the browser number for both.
 */

import { chromium } from 'playwright-core';

const EXE =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const url = process.argv[2];
if (!url) {
  console.error('usage: node tests/perf/export_gates.mjs "<tokenised url>"');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: EXE,
  // performance.memory is gated; this makes the heap readable so G11 is a measurement
  // rather than a shrug.
  args: ['--enable-precise-memory-info'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const result = await page.evaluate(async () => {
  const k = globalThis.__kernel;
  const pages = k.geometry?.pages?.length ?? 0;
  const heap = () => performance.memory?.usedJSHeapSize ?? null;

  const before = heap();
  let peak = before ?? 0;
  const sampler = setInterval(() => {
    const h = heap();
    if (h !== null && h > peak) peak = h;
  }, 100);

  const t0 = performance.now();
  const res = await k.exportPdf(200);
  const total = performance.now() - t0;
  clearInterval(sampler);

  // The controller records the server's own per-page timings; read them rather than
  // timing the fetch from here.
  const t = k.exporter?.lastTimings ?? null;
  return {
    pages,
    path: res?.path ?? null,
    total,
    before,
    peak,
    heapAvailable: before !== null,
    timings: t
      ? {
          rasterMs: t.rasterMs,
          receiveMs: t.receiveMs,
          artifactMs: [...t.artifactMs],
          pageBytes: [...t.pageBytes],
        }
      : null,
  };
});

await browser.close();

if (!result.path) {
  console.log('export was refused or failed; nothing to measure');
  console.log('errors:', errors.length ? errors : 'none');
  process.exit(1);
}

const mb = (b) => (b / 1024 / 1024).toFixed(0);
const perPage = result.total / Math.max(1, result.pages);

console.log(`exported ${result.pages} page(s) -> ${result.path}`);
console.log();
console.log(`G9   full export, ${String(result.pages).padStart(2)} pages   ${(result.total / 1000).toFixed(1).padStart(7)} s      budget 90 s for 20   ${result.total / 1000 <= 90 ? 'PASS' : 'FAIL'}`);
console.log(`     per page                     ${(perPage / 1000).toFixed(2).padStart(7)} s`);

if (result.heapAvailable) {
  console.log(
    `G11  peak browser heap          ${mb(result.peak).padStart(7)} MB     budget 1200 MB       ` +
      `${result.peak <= 1.2 * 1024 * 1024 * 1024 ? 'PASS' : 'FAIL'}`,
  );
  console.log(`     heap before export         ${mb(result.before).padStart(7)} MB`);
} else {
  console.log('G11  NOT MEASURED — performance.memory unavailable in this browser build');
}

const t = result.timings;
function line(id, what, samples, budget, unit, scale = 1) {
  if (!samples || samples.length === 0) {
    console.log(`${id.padEnd(4)} ${what.padEnd(30)} NOT MEASURED`);
    return;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const v = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] / scale;
  const b = budget / scale;
  console.log(
    `${id.padEnd(4)} ${what.padEnd(30)} ${v.toFixed(1).padStart(7)} ${unit}  ` +
      `budget ${b.toFixed(0).padStart(5)}   ${v <= b ? 'PASS' : 'FAIL'}`,
  );
}

if (t) {
  console.log();
  line('G6', 'rasterize one page @200', t.rasterMs, 900, 'ms');
  line('G7', 'raw POST + decode (server)', t.receiveMs, 40, 'ms');
  line('G8', 'artifact pipeline (server)', t.artifactMs, 2500, 'ms');
  line('G10', 'PDF bytes per page', t.pageBytes, 700 * 1024, 'KB', 1024);
}

console.log();
console.log('NOT MEASURED HERE:');
console.log('  G11 (Python half)  needs psutil RSS sampling inside the server process.');
console.log('errors:', errors.length ? errors.slice(0, 3) : 'none');
