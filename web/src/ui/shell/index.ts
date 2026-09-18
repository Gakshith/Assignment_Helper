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

interface KernelLike {
  actions: Parameters<typeof mountActionBar>[1]['actions'];
  exportPdf(dpi?: number): Promise<{ path: string } | null>;
  readonly canExport: boolean;
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
  if (existing) {
    attachActionBar(existing);
  } else {
    globalThis.addEventListener(
      'ah:kernel-ready',
      (ev) => attachActionBar((ev as CustomEvent<KernelLike>).detail),
      { once: true },
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
