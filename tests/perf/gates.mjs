/**
 * The performance gates that need a real browser, a real document and the real
 * pipeline. Run it against a running server:
 *
 *   assignment-helper hw.md --no-browser --print-url
 *   node tests/perf/gates.mjs "<the printed URL>"
 *
 * Deliberately NOT a vitest file. These measure the assembled app; a unit test that
 * mocks the canvas would report a number about the mock.
 *
 * Every figure printed here came from this script. Anything it cannot measure it says
 * it cannot measure — an estimate presented as a measurement is worse than a blank.
 */

import { chromium } from 'playwright-core';

const EXE =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const GATES = {
  G1: { what: 'single-block repaint, no reflow', budget: 40, hardFail: 80, unit: 'ms p95' },
  G2: { what: 'single-block edit that reflows', budget: 120, hardFail: 250, unit: 'ms p95' },
  G3: { what: 'full-page render, warm paper', budget: 400, hardFail: 800, unit: 'ms p95' },
  G4c: { what: 'paper layer, cold', budget: 1200, hardFail: 2500, unit: 'ms' },
  G4w: { what: 'paper layer, warm', budget: 5, hardFail: 25, unit: 'ms' },
};

function p95(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

const url = process.argv[2];
if (!url) {
  console.error('usage: node tests/perf/gates.mjs "<tokenised url from --print-url>"');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const measured = await page.evaluate(async () => {
  const k = globalThis.__kernel;
  if (!k) throw new Error('the kernel did not boot');
  const out = {};

  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

  /**
   * Read the SCHEDULER'S OWN timing, not wall time across two rAFs.
   *
   * The first version of this script bracketed `invalidate()` with two awaited frames
   * and reported the difference. At 60 Hz that is ~33 ms of vsync, so it measured the
   * display refresh and would have reported ~35 ms as the repaint cost — comfortably
   * "passing" G1's 40 ms budget while saying nothing about the code. The kernel already
   * records the real flush duration, because invariant I1 bans performance.now() inside
   * render/** and the instrumentation had to live in kernel.ts anyway.
   */
  const sample = async (invalidate) => {
    invalidate();
    await frame();
    await frame();
    return k.scheduler.lastFlushMs;
  };

  // G3 — full-page render with the paper cache warm.
  const g3 = [];
  for (let i = 0; i < 30; i++) g3.push(await sample(() => k.scheduler.invalidateAll()));
  out.G3 = g3;

  // G1 — one block dirty, no reflow.
  const geom = k.geometry;
  const firstBlock = geom?.pages?.[0]?.blocks?.[0]?.blockId ?? null;
  out.blockId = firstBlock;
  const g1 = [];
  if (firstBlock) {
    for (let i = 0; i < 60; i++) {
      g1.push(await sample(() => k.scheduler.invalidateBlock(firstBlock)));
    }
  }
  out.G1 = g1;

  out.pages = geom?.pages?.length ?? 0;
  out.blocks = (geom?.pages ?? []).reduce((n, p) => n + p.blocks.length, 0);
  return out;
});

await browser.close();

console.log(`document: ${measured.pages} page(s), ${measured.blocks} block(s)\n`);

function report(id, samples) {
  const g = GATES[id];
  if (!samples || samples.length === 0) {
    console.log(`${id.padEnd(4)} ${g.what.padEnd(34)} NOT MEASURED`);
    return null;
  }
  const v = p95(samples);
  const verdict = v > g.hardFail ? 'HARD FAIL' : v <= g.budget ? 'PASS' : 'OVER BUDGET';
  console.log(
    `${id.padEnd(4)} ${g.what.padEnd(34)} ${v.toFixed(1).padStart(8)} ${g.unit}   ` +
      `budget ${String(g.budget).padStart(5)}   ${verdict}`,
  );
  return verdict;
}

const verdicts = [report('G3', measured.G3), report('G1', measured.G1)];

console.log('\nNOT MEASURED BY THIS SCRIPT, and why:');
console.log('  G2   needs a text edit that reflows — drive actions.editBlock with a longer string');
console.log('  G4   paper cold/warm is internal to the paper engine; it has its own harness');
console.log('  G11  needs a browser memory sample during a 20-page export');
console.log('  G16  needs two renders at different DPI and an SSIM comparison of the INK MASK only');
console.log('  G12  needs a printed tracing sheet and a phone');
console.log('  G13  needs a clean install');
console.log('  G14  needs a live API key');

if (pageErrors.length) {
  console.log('\nPAGE ERRORS (these invalidate the numbers above):');
  for (const e of pageErrors.slice(0, 5)) console.log('  ' + e);
}

process.exit(verdicts.some((v) => v === 'HARD FAIL') ? 1 : 0);
