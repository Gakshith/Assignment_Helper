/**
 * The entry point. It does one job: build the three hosts, assemble the subsystem
 * registry, and start the kernel. Strands swap an import here; nothing else moves.
 */

import { Kernel, type KernelSubsystems } from './app/kernel';
import {
  makeStubExport,
  makeStubProtocol,
  stubChat,
  stubFigures,
  stubGlyphs,
  stubLasso,
  stubLayout,
  stubPaint,
  stubPaper,
  stubStylePanel,
} from './app/stubs';
import type { Document } from './types/document';

const EMPTY_DOC: Document = {
  schema_version: 1,
  id: 'bootstrap',
  title: '',
  blocks: [],
};

function host(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing host element #${id}`);
  return el;
}

async function boot(): Promise<void> {
  const hosts = {
    pages: host('pages'),
    rightPanel: host('right-panel'),
    chatDock: host('chat-dock'),
  };

  const protocol = makeStubProtocol(EMPTY_DOC);
  const subsystems: KernelSubsystems = {
    layout: stubLayout,
    paint: stubPaint,
    paper: stubPaper,
    figures: stubFigures,
    glyphs: stubGlyphs,
    protocol,
    exporter: makeStubExport({ raise: (p) => console.error(p), clearBlock: () => {}, all: [], onChange: () => {} }),
    chat: stubChat,
    style: stubStylePanel,
    lasso: stubLasso,
  };

  const kernel = new Kernel(subsystems, hosts);
  // Deliberately unguarded: a boot failure must be loud (invariant I5).
  await kernel.start();
  (globalThis as Record<string, unknown>)['__kernel'] = kernel;
}

void boot();
