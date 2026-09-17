/**
 * The entry point. ***FROZEN.*** Do not modify on a strand branch.
 *
 * Every subsystem is imported from a FIXED PATH that exactly one strand owns. A strand
 * fills in its own index file; this file never changes and never becomes a merge
 * conflict. That is the whole reason it is written this way — without it, all ten
 * strands would edit these same twenty lines.
 *
 *   render/layout/index.ts   render/paint/index.ts    render/paper/index.ts
 *   render/figures/index.ts  render/glyphs/index.ts   app/protocol.ts
 *   export/index.ts          ui/chat/index.ts         ui/panels/index.ts
 *   ui/lasso/index.ts
 */

import { Kernel, type KernelSubsystems } from './app/kernel';
import { createProtocol } from './app/protocol';
import { figuresRenderer } from './render/figures/index';
import { glyphProfileProvider } from './render/glyphs/index';
import { layoutEngine } from './render/layout/index';
import { paintEngine } from './render/paint/index';
import { paperEngine } from './render/paper/index';
import { createExportController } from './export/index';
import { chatPanel } from './ui/chat/index';
import { stylePanel } from './ui/panels/index';
import { lassoController } from './ui/lasso/index';

function host(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing host element #${id}`);
  return el;
}

/**
 * The session token arrives once in the launch URL and is stripped immediately.
 * sessionStorage, not memory (F5 would log you out of your own app) and not
 * localStorage (it must die with the tab). Invariant I16.
 */
function claimToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('t');
  if (fromUrl) {
    try {
      sessionStorage.setItem('ah.token', fromUrl);
    } catch (err) {
      // Not swallowed: without storage the next reload loses the session, and the
      // user needs to know why rather than meeting a silent 403.
      console.error('could not persist the session token to sessionStorage', err);
    }
    url.searchParams.delete('t');
    history.replaceState(null, '', url.toString());
    return fromUrl;
  }
  try {
    return sessionStorage.getItem('ah.token');
  } catch {
    return null;
  }
}

async function boot(): Promise<void> {
  const hosts = {
    pages: host('pages'),
    rightPanel: host('right-panel'),
    chatDock: host('chat-dock'),
  };

  const token = claimToken();
  const subsystems: KernelSubsystems = {
    layout: layoutEngine,
    paint: paintEngine,
    paper: paperEngine,
    figures: figuresRenderer,
    glyphs: glyphProfileProvider,
    protocol: createProtocol({ token }),
    exporter: createExportController({ token }),
    chat: chatPanel,
    style: stylePanel,
    lasso: lassoController,
  };

  const kernel = new Kernel(subsystems, hosts);
  // Deliberately unguarded: a boot failure must be loud (invariant I5).
  await kernel.start();
  (globalThis as Record<string, unknown>)['__kernel'] = kernel;
}

void boot();
