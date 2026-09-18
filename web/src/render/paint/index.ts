// OWNER: the paint strand. Replace the export; do not touch main.ts.
import type { PaintEngine } from '../../app/contracts';
import { OutlinePaintEngine } from './engine';

export const paintEngine: PaintEngine = new OutlinePaintEngine();

export { OutlinePaintEngine, PaintOutlineError, type MissingOutline } from './engine';
export { OutlineCache, MAX_ENTRIES, MAX_BYTES } from './cache';
export { DEFAULT_INK, INK_ALPHA, INK_KERNEL_RADIUS_MM, INK_WEIGHT_MM, inkFor } from './ink';
export { emToDeviceMatrix, placementBoundsMm, placementMatrix, type Matrix2D } from './transform';
