// OWNER: the export strand.
import type { ExportController } from '../app/contracts';
import { BrowserExportController } from './controller';

export function createExportController(opts: { token: string | null }): ExportController {
  return new BrowserExportController(opts.token);
}

export { BrowserExportController, ExportBlocked } from './controller';
