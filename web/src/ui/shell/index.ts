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

function boot(): void {
  // Deliberately unguarded, like main.ts: a chrome that failed to mount must be
  // loud, because it is the thing that would otherwise report the failure.
  mountChrome();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
