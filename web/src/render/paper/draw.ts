/**
 * The paper pass. Pure: a PaperCtx, resolved params and a seed in, drawing commands out.
 *
 * Every number in this file is millimetres, a 0..1 ratio, or a count. There is not one
 * pixel literal, and there cannot be — PaperCtx has no pixel-shaped method (I8).
 *
 * The rule pitch and margin position are M0's, checked against a real sheet of college
 * paper: 7.1 mm between rules, 31.75 mm (1.25 in) to the red margin rule. They live in
 * the frozen `RULING` table, not here.
 */

import { rand } from '../rng';
import { RULING, type Mm, type RectMm } from '../units';
import type { PaperCtx } from './surface';
import type { PaperParams } from './params';
import { grainTile } from './grain';

/**
 * The first rule, measured down from the top edge. M0's `marginTop`: it is also where
 * the first baseline sits, so text lands ON a rule rather than 1 mm above it.
 */
export const RULE_ORIGIN_MM: Mm = 26;

const RULE_WIDTH_MM: Mm = 0.16;
const MARGIN_RULE_WIDTH_MM: Mm = 0.22;
const GRID_WIDTH_MM: Mm = 0.11;

const TONE_BLOBS = 26;
const FIBRES_SMOOTH = 420;
const FIBRES_ROUGH = 1150;

/**
 * Much higher than it looks, and it has to be.
 *
 * The speckle is composited in `overlay`, which is the right mode — it is exactly
 * neutral at mid-grey, so noise centred on 128 adds no tint and no mean shift. But
 * overlay COMPRESSES against a light backdrop: for a base luminance b > 0.5 the output
 * spans `2*(1-b)` of the blend's range, and paper sits at b ~= 0.94, so only 12% of it
 * survives. At M0's 0.085 the measured variation on a flat region was 0.37 luminance
 * levels out of 255 — arithmetically present, invisible on screen.
 *
 * Bilinear upscaling of the tile costs some more. 0.85 * the grain dial measures 2.55
 * levels of standard deviation on a flat region at the 0.55 default — about what a
 * scan of copier stock shows, and still invisible as "a texture" at 100%. Believability
 * wins over PDF size here by decision (G10 is a warning, not a gate), so do not lower
 * this to shrink the export.
 */
const GRAIN_ALPHA = 0.85;
const FIBRE_ALPHA_SMOOTH = 0.055;
const FIBRE_ALPHA_ROUGH = 0.085;

/** A sheet lying on a scanner bed picks up a hair of edge shading even when new. */
const EDGE_SHADE_MM: Mm = 4.5;
const EDGE_SHADE_ALPHA = 0.03;
/** Yellowing reaches this far in from each edge at aging = 1. */
const AGING_BAND_MM: Mm = 20;
const AGING_EDGE_ALPHA = 0.1;
const VIGNETTE_BASE_ALPHA = 0.01;
const VIGNETTE_AGING_ALPHA = 0.045;

/**
 * The deckle is stepped, and the step has to be far below the eye's resolution or it
 * reads as perforation rather than a tear. At 1.6 mm with an independent depth per step
 * it looked like a row of tabs; 0.35 mm with a depth that undulates smoothly over a
 * ~4 mm wavelength looks torn.
 */
const FRINGE_STEP_MM: Mm = 0.35;
const FRINGE_MIN_MM: Mm = 0.12;
const FRINGE_MAX_MM: Mm = 0.75;
const FRINGE_LAMBDA_MM: Mm = 4;
const FRINGE_SHADOW_MM: Mm = 0.3;
const FRINGE_LIT = 'rgba(255,253,246,0.34)';
const FRINGE_SHADOW = 'rgba(120,108,84,0.06)';

const EDGES = ['down', 'up', 'right', 'left'] as const;
type Edge = 'top' | 'bottom' | 'left' | 'right';
const DECKLE_EDGES: readonly Edge[] = ['top', 'bottom', 'left', 'right'];

/**
 * Smooth value noise over a real parameter, built from the frozen counter-based PRNG.
 * `rand` alone is white noise — neighbouring samples are independent, which is what
 * made the first deckle look machine-cut. Interpolating between lattice draws with a
 * smoothstep gives a value that varies CONTINUOUSLY along the edge, like a fibre tear.
 */
function vnoise(seed: bigint, purpose: string, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = rand(seed, purpose, i);
  const b = rand(seed, purpose, i + 1);
  return a + (b - a) * (f * f * (3 - 2 * f));
}

export function drawPaper(ctx: PaperCtx, p: PaperParams, seed: bigint): void {
  drawBase(ctx, p, seed);
  drawRuling(ctx, p);
  drawGrain(ctx, p, seed);
  drawAging(ctx, p);
  if (p.kind === 'rough') drawDeckle(ctx, p, seed);
}

// ---------------------------------------------------------------- base tone

function drawBase(ctx: PaperCtx, p: PaperParams, seed: bigint): void {
  ctx.fillSheet(p.tint);

  // Paper is never one flat colour. A handful of very wide, very faint blobs breaks the
  // "filled rectangle" read before any grain lands on top of it.
  for (let i = 0; i < TONE_BLOBS; i++) {
    const cxMm = rand(seed, 'paper.tone.x', i) * p.widthMm;
    const cyMm = rand(seed, 'paper.tone.y', i) * p.heightMm;
    const rMm = 14 + rand(seed, 'paper.tone.r', i) * 52;
    const a = Math.abs(0.012 * (rand(seed, 'paper.tone.a', i) - 0.42));
    ctx.fillRadial(
      { xMm: cxMm - rMm, yMm: cyMm - rMm, wMm: rMm * 2, hMm: rMm * 2 },
      { cxMm, cyMm, innerRMm: 0, outerRMm: rMm },
      [
        { at: 0, colour: `rgba(120,104,72,${a.toFixed(4)})` },
        { at: 1, colour: 'rgba(120,104,72,0)' },
      ],
    );
  }
}

// ---------------------------------------------------------------- ruling

function drawRuling(ctx: PaperCtx, p: PaperParams): void {
  if (p.kind === 'ruled') drawRules(ctx, p);
  else if (p.kind === 'grid') drawGrid(ctx, p);
  // plain and rough carry no ruling at all — tint, grain and aging only.
}

function drawRules(ctx: PaperCtx, p: PaperParams): void {
  const { pitchMm, marginFromLeftMm } = RULING[p.ruling];

  // Horizontal rules, full page width.
  for (let y = RULE_ORIGIN_MM; y <= p.heightMm; y += pitchMm) {
    ctx.strokeLine(
      { x0Mm: 0, y0Mm: y, x1Mm: p.widthMm, y1Mm: y },
      p.ruleColour,
      RULE_WIDTH_MM,
    );
  }

  // The red margin rule, full page height. Skipped when the ruling has no margin.
  if (marginFromLeftMm > 0) {
    ctx.strokeLine(
      { x0Mm: marginFromLeftMm, y0Mm: 0, x1Mm: marginFromLeftMm, y1Mm: p.heightMm },
      p.marginRuleColour,
      MARGIN_RULE_WIDTH_MM,
    );
  }
}

function drawGrid(ctx: PaperCtx, p: PaperParams): void {
  const { pitchMm } = RULING[p.ruling];
  for (let x = pitchMm; x < p.widthMm; x += pitchMm) {
    ctx.strokeLine({ x0Mm: x, y0Mm: 0, x1Mm: x, y1Mm: p.heightMm }, p.ruleColour, GRID_WIDTH_MM);
  }
  for (let y = pitchMm; y < p.heightMm; y += pitchMm) {
    ctx.strokeLine({ x0Mm: 0, y0Mm: y, x1Mm: p.widthMm, y1Mm: y }, p.ruleColour, GRID_WIDTH_MM);
  }
}

// ---------------------------------------------------------------- grain and fibre

function drawGrain(ctx: PaperCtx, p: PaperParams, seed: bigint): void {
  if (p.grain <= 0) return;
  const rough = p.kind === 'rough';

  ctx.overlayNoise(grainTile(seed, p.widthMm, p.heightMm), GRAIN_ALPHA * p.grain);

  // Fibres: short light and dark hairs in the stock. Rough paper gets nearly three
  // times as many, which is most of what distinguishes it from plain at a glance.
  const count = Math.round((rough ? FIBRES_ROUGH : FIBRES_SMOOTH) * p.grain);
  const alpha = (rough ? FIBRE_ALPHA_ROUGH : FIBRE_ALPHA_SMOOTH) * p.grain;
  for (let i = 0; i < count; i++) {
    const x = rand(seed, 'paper.fibre.x', i) * p.widthMm;
    const y = rand(seed, 'paper.fibre.y', i) * p.heightMm;
    const angle = rand(seed, 'paper.fibre.a', i) * Math.PI * 2;
    const lenMm = 0.7 + rand(seed, 'paper.fibre.l', i) * (rough ? 5.6 : 4.2);
    const dark = rand(seed, 'paper.fibre.d', i) < 0.55;
    const widthMm = 0.055 + rand(seed, 'paper.fibre.w', i) * (rough ? 0.085 : 0.055);
    const colour = dark
      ? `rgba(96,86,64,${alpha.toFixed(4)})`
      : `rgba(255,253,246,${alpha.toFixed(4)})`;
    ctx.strokeLine(
      {
        x0Mm: x,
        y0Mm: y,
        x1Mm: x + Math.cos(angle) * lenMm,
        y1Mm: y + Math.sin(angle) * lenMm,
      },
      colour,
      widthMm,
    );
  }
}

// ---------------------------------------------------------------- aging

/**
 * Restrained on purpose. This is a drafting table, not a fantasy prop: at aging = 1 the
 * sheet reads as "left in a folder for a year", never as a treasure map.
 */
function drawAging(ctx: PaperCtx, p: PaperParams): void {
  const sheet = { xMm: 0, yMm: 0, wMm: p.widthMm, hMm: p.heightMm };

  // Always-on edge shading, then amber yellowing scaled by the dial on top of it.
  for (const dir of EDGES) {
    ctx.fillLinear(bandRect(p, dir, EDGE_SHADE_MM), dir, [
      { at: 0, colour: `rgba(40,34,22,${EDGE_SHADE_ALPHA})` },
      { at: 1, colour: 'rgba(40,34,22,0)' },
    ]);
  }

  if (p.aging > 0) {
    const a = (AGING_EDGE_ALPHA * p.aging).toFixed(4);
    for (const dir of EDGES) {
      ctx.fillLinear(bandRect(p, dir, AGING_BAND_MM), dir, [
        { at: 0, colour: `rgba(152,118,52,${a})` },
        { at: 1, colour: 'rgba(152,118,52,0)' },
      ]);
    }
  }

  const outer = (VIGNETTE_BASE_ALPHA + VIGNETTE_AGING_ALPHA * p.aging).toFixed(4);
  const mid = (Number(outer) * 0.28).toFixed(4);
  ctx.fillRadial(
    sheet,
    {
      cxMm: p.widthMm / 2,
      cyMm: p.heightMm / 2,
      innerRMm: Math.min(p.widthMm, p.heightMm) * 0.32,
      outerRMm: Math.max(p.widthMm, p.heightMm) * 0.74,
    },
    [
      { at: 0, colour: 'rgba(40,34,22,0)' },
      { at: 0.78, colour: `rgba(40,34,22,${mid})` },
      { at: 1, colour: `rgba(40,34,22,${outer})` },
    ],
  );
}

/** The strip along one edge that a gradient running inward fills. */
function bandRect(
  p: PaperParams,
  dir: (typeof EDGES)[number],
  depthMm: Mm,
): { xMm: Mm; yMm: Mm; wMm: Mm; hMm: Mm } {
  switch (dir) {
    case 'down':
      return { xMm: 0, yMm: 0, wMm: p.widthMm, hMm: depthMm };
    case 'up':
      return { xMm: 0, yMm: p.heightMm - depthMm, wMm: p.widthMm, hMm: depthMm };
    case 'right':
      return { xMm: 0, yMm: 0, wMm: depthMm, hMm: p.heightMm };
    case 'left':
      return { xMm: p.widthMm - depthMm, yMm: 0, wMm: depthMm, hMm: p.heightMm };
  }
}

// ---------------------------------------------------------------- rough edge

/**
 * Rough paper's deckle.
 *
 * The sheet itself stays a true rectangle — page corner radius is 0 and a rounded page
 * reads as a sticker — but the last millimetre of it is torn rather than guillotined:
 * a band of catch-the-light fibre whose depth undulates along the edge, with a hair of
 * shadow just inside it.
 */
function drawDeckle(ctx: PaperCtx, p: PaperParams, seed: bigint): void {
  for (const edge of DECKLE_EDGES) {
    const runMm = edge === 'top' || edge === 'bottom' ? p.widthMm : p.heightMm;
    for (let s = 0; s < runMm; s += FRINGE_STEP_MM) {
      const len = Math.min(FRINGE_STEP_MM, runMm - s);
      const n = vnoise(seed, `paper.deckle.${edge}`, s / FRINGE_LAMBDA_MM);
      const depth = FRINGE_MIN_MM + n * (FRINGE_MAX_MM - FRINGE_MIN_MM);
      ctx.fillRect(deckleRect(p, edge, s, len, depth, false), FRINGE_LIT);
      ctx.fillRect(deckleRect(p, edge, s, len, depth, true), FRINGE_SHADOW);
    }
  }
}

/** The torn strip at `sMm` along `edge` — or, with `inside`, the shadow just behind it. */
function deckleRect(
  p: PaperParams,
  edge: Edge,
  sMm: Mm,
  lenMm: Mm,
  depthMm: Mm,
  inside: boolean,
): RectMm {
  const d = inside ? FRINGE_SHADOW_MM : depthMm;
  const off = inside ? depthMm : 0;
  switch (edge) {
    case 'top':
      return { xMm: sMm, yMm: off, wMm: lenMm, hMm: d };
    case 'bottom':
      return { xMm: sMm, yMm: p.heightMm - off - d, wMm: lenMm, hMm: d };
    case 'left':
      return { xMm: off, yMm: sMm, wMm: d, hMm: lenMm };
    case 'right':
      return { xMm: p.widthMm - off - d, yMm: sMm, wMm: d, hMm: lenMm };
  }
}
