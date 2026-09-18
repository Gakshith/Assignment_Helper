/**
 * The shell entry point. A SECOND module entry alongside the frozen main.ts.
 *
 * main.ts imports ten fixed subsystem paths and mounts three hosts through the
 * kernel; none of them owns the top bar, the icon rail or the dock chrome, and the
 * kernel never touches them. Bootstrapping the chrome from inside ui/panels would
 * make the frame a side effect of the style panel and would take the whole frame
 * down with it. A separate entry keeps the banner alive for precisely the failures
 * that need reporting.
 */

import { mountChrome } from './chrome';
import { mountActionBar } from './actionbar';
import { createGlyphStudio, request } from '../glyphstudio/index';

interface KernelLike {
  actions: Parameters<typeof mountActionBar>[1]['actions'];
  exportPdf(dpi?: number): Promise<{ path: string } | null>;
  readonly canExport: boolean;
  currentProfile(): string;
}

/**
 * The glyph studio lives in the right panel, behind the rail's hand icon.
 *
 * Acceptance row 9: with no profile this is where a first launch lands, and it must
 * read as a starting point rather than an error — a page already renders in the
 * reference hand while the user decides whether to make their own.
 */
function attachGlyphStudio(kernel: KernelLike): void {
  const panel = document.getElementById('right-panel');
  if (!panel) return;

  const mount = document.createElement('section');
  mount.id = 'glyph-studio';
  mount.hidden = true;
  panel.append(mount);

  const studio = createGlyphStudio({
    actions: kernel.actions,
    currentProfile: () => kernel.currentProfile(),
    request,
  } as never);
  studio.mount(mount);

  const toggle = document.getElementById('rail-hand');
  toggle?.addEventListener('click', () => {
    mount.hidden = !mount.hidden;
    if (!mount.hidden) void studio.refresh();
  });
}

function attachActionBar(kernel: KernelLike): void {
  const bar = document.getElementById('top-bar');
  if (!bar) throw new Error('shell: #top-bar is missing; the action bar has nowhere to go');
  mountActionBar(bar, {
    actions: kernel.actions,
    exportPdf: () => kernel.exportPdf(),
    canExport: () => kernel.canExport,
    status: () => {},
  });
}

function boot(): void {
  // Deliberately unguarded, like main.ts: a chrome that failed to mount must be
  // loud, because it is the thing that would otherwise report the failure.
  mountChrome();

  // The kernel is a separate entry with no ordering guarantee, so handle both: it may
  // already be up, or it may announce itself later.
  const existing = (globalThis as { __kernel?: KernelLike }).__kernel;
  const attach = (kernel: KernelLike): void => {
    attachActionBar(kernel);
    attachGlyphStudio(kernel);
  };
  if (existing) {
    attach(existing);
  } else {
    globalThis.addEventListener(
      'ah:kernel-ready',
      (ev) => attach((ev as CustomEvent<KernelLike>).detail),
      { once: true },
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
