// OWNER: the paper strand. Replace the export; do not touch main.ts.
import type { PaperEngine } from '../../app/contracts';
import { createPaperEngine } from './engine';

export const paperEngine: PaperEngine = createPaperEngine();

export { createPaperEngine, type ProceduralPaperEngine } from './engine';
