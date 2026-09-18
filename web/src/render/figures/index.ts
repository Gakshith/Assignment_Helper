// OWNER: the figures strand.
import type { FiguresRenderer } from '../../app/contracts';
import { SketchFiguresRenderer } from './engine';

export const figuresRenderer: FiguresRenderer = new SketchFiguresRenderer();
export { SketchFiguresRenderer } from './engine';
