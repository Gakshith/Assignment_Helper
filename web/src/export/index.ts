// OWNER: the export strand. Replace the implementation; do not touch main.ts.
import { makeStubExport } from '../app/stubs';
import type { ExportController } from '../app/contracts';

export function createExportController(_opts: { token: string | null }): ExportController {
  return makeStubExport({ raise: (p) => console.error(p), clearBlock: () => {}, all: [], onChange: () => {} });
}
