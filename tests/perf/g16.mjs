/**
 * G16 — preview/export resolution parity, on the INK MASK ONLY.
 *
 *   node tests/perf/g16.mjs "<tokenised url>"    # writes two PNGs
 *   python tests/perf/g16_ssim.py                # computes the SSIM
 *
 * Paper is EXCLUDED from the comparison and that is not a convenience. Procedural
 * grain is high-frequency noise generated per device pixel: it is resolution-dependent
 * by construction, so comparing it makes this gate unpassable for a reason that has
 * nothing to do with parity. The thing G16 actually asks is whether the same geometry,
 * painted at two resolutions, puts ink in the same PLACE.
 *
 * This is the check that would catch export silently upscaling a preview bitmap
 * (invariant I11) or re-running layout at export DPI, which §C.6 corrected: geometry is
 * computed once at no DPI and re-PAINTED at export DPI.
 */

import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const EXE =
  process.env.HOME +
  '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

const OUT = '/Users/gojuruakshith/.claude/jobs/7f9afd6b/tmp';

const url = process.argv[2];
if (!url) {
  console.error('usage: node tests/perf/g16.mjs "<tokenised url from --print-url>"');
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const shots = await page.evaluate(async (dpis) => {
  const k = globalThis.__kernel;
  const sources = k.sources;
  if (!sources) throw new Error('the kernel has not started');
  const geometry = sources.geometry();
  const style = sources.style();
  const outlines = sources.outlines();
  if (!geometry || !style || !outlines) throw new Error('nothing rendered');
  const pageGeom = geometry.pages[0];

  const out = {};
  for (const dpi of dpis) {
    const mm2px = (mm) => Math.round((mm / 25.4) * dpi);
    const w = mm2px(pageGeom.widthMm);
    const h = mm2px(pageGeom.heightMm);
    const make = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    const layers = { pageIndex: 0, paper: make(), ink: make(), overlay: make(), dpi };
    // INK ONLY. No paper: see the note at the top of this file.
    sources.paint.paintInk(layers, pageGeom, style, outlines);
    const blob = await new Promise((r) => layers.ink.toBlob(r, 'image/png'));
    out[dpi] = { w, h, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  }

  // G17 — re-render determinism. The SAME geometry painted twice at the SAME DPI, in
  // one browser session. I2 already argues byte-identical is false (Canvas2D is GPU-
  // and driver-dependent), so the invariant is SSIM >= 0.999 and a failure after a
  // driver or browser update is re-baselined rather than debugged as a product bug.
  const again = (() => {
    const dpi = 150;
    const mm2px = (mm) => Math.round((mm / 25.4) * dpi);
    const w = mm2px(pageGeom.widthMm);
    const h = mm2px(pageGeom.heightMm);
    const make = () => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    const layers = { pageIndex: 0, paper: make(), ink: make(), overlay: make(), dpi };
    sources.paint.paintInk(layers, pageGeom, style, outlines);
    return layers.ink;
  })();
  const againBlob = await new Promise((r) => again.toBlob(r, 'image/png'));
  out.repeat = { bytes: Array.from(new Uint8Array(await againBlob.arrayBuffer())) };

  return out;
}, [150, 300]);

if (shots.repeat) {
  writeFileSync(`${OUT}/g17-ink-repeat.png`, Buffer.from(shots.repeat.bytes));
  console.log('ink @150 DPI, painted a second time -> g17-ink-repeat.png');
  delete shots.repeat;
}

for (const [dpi, shot] of Object.entries(shots)) {
  writeFileSync(`${OUT}/g16-ink-${dpi}.png`, Buffer.from(shot.bytes));
  console.log(`ink @${dpi} DPI: ${shot.w}x${shot.h} -> g16-ink-${dpi}.png`);
}
console.log('errors:', errors.length ? errors.slice(0, 3) : 'none');
await browser.close();
