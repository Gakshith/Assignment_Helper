/**
 * The app-scope problem feed.
 *
 * ============================== CONTRACT BUG ==============================
 * `StylePanel` in app/contracts.ts declares exactly `name` and `mount(host)`. The
 * kernel owns the problem sink and exposes `problems.onChange(...)`, but it hands a
 * panel NOTHING except a host element, so there is no sanctioned route from a UI
 * strand to that sink. Invariant I5 requires one: an app-scope problem the user
 * cannot see is a silent failure with extra steps.
 *
 * This is reported to the lead as a contract bug rather than worked around quietly.
 * The fix is one line in contracts.ts plus one in kernel.ts -- give `mount` a second
 * argument, e.g. `mount(host: HTMLElement, ctx: { problems: ProblemSink })` -- and
 * then `attach()` below is called directly and `bridgeToKernel()` is deleted whole.
 *
 * Until that lands, the feed attaches to the kernel main.ts already publishes on
 * globalThis. That bridge is bounded and LOUD: if the kernel never appears, the feed
 * raises its own problem saying the channel could not be attached, so the failure of
 * the failure channel is itself visible.
 * =========================================================================
 */

import type { Problem } from '../../types/document';

/** The slice of ProblemSink this module needs. Structural, so the real sink fits. */
export interface ProblemFeedSource {
  onChange(handler: (all: readonly Problem[]) => void): void;
  readonly all: readonly Problem[];
}

type Listener = (all: readonly Problem[]) => void;

const listeners: Listener[] = [];
/** Problems this module raised itself, kept apart from the kernel's. */
let local: Problem[] = [];
let fromKernel: readonly Problem[] = [];
let attached = false;

function emit(): void {
  const all = [...local, ...fromKernel];
  for (const listener of listeners) listener(all);
}

export function onProblems(listener: Listener): void {
  listeners.push(listener);
  listener([...local, ...fromKernel]);
}

/**
 * Raise a problem the UI itself discovered. Also logged, for the same reason the
 * kernel logs: a banner the user scrolled past is not a record.
 */
export function raiseLocal(problem: Problem): void {
  local = [...local.filter((p) => p.code !== problem.code), problem];
  console.error(`[problem:${problem.scope}] ${problem.code}: ${problem.message}`, problem.detail ?? '');
  emit();
}

export function clearLocal(code: string): void {
  const before = local.length;
  local = local.filter((p) => p.code !== code);
  if (local.length !== before) emit();
}

/** The sanctioned entry point, ready for the day the contract passes a sink in. */
export function attach(source: ProblemFeedSource): void {
  if (attached) return;
  attached = true;
  fromKernel = source.all;
  source.onChange((all) => {
    fromKernel = all;
    emit();
  });
  emit();
}

interface KernelShape {
  readonly problems: ProblemFeedSource;
}

function kernelOnGlobal(): KernelShape | null {
  const candidate = (globalThis as Record<string, unknown>)['__kernel'];
  if (typeof candidate !== 'object' || candidate === null) return null;
  const problems = (candidate as Record<string, unknown>)['problems'];
  if (typeof problems !== 'object' || problems === null) return null;
  const sink = problems as Record<string, unknown>;
  if (typeof sink['onChange'] !== 'function' || !('all' in sink)) return null;
  return candidate as unknown as KernelShape;
}

/** Poll budget. Long enough for a slow boot, short enough to report inside a minute. */
export const BRIDGE_BUDGET_MS = 20000;
const BRIDGE_INTERVAL_MS = 120;

/** TEMPORARY. Deleted the day `mount` receives a ProblemSink. See the header. */
export function bridgeToKernel(
  now: () => number = () => Date.now(),
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): void {
  const started = now();
  const tick = (): void => {
    const kernel = kernelOnGlobal();
    if (kernel) {
      attach(kernel.problems);
      return;
    }
    if (now() - started >= BRIDGE_BUDGET_MS) {
      raiseLocal({
        scope: 'app',
        code: 'ui.problem-channel-unattached',
        message:
          'The problem channel is not attached, so subsystem failures will not appear here. ' +
          'The kernel never came up, or StylePanel.mount was never given a problem sink.',
        detail: `waited ${BRIDGE_BUDGET_MS} ms for globalThis.__kernel`,
      });
      return;
    }
    schedule(tick, BRIDGE_INTERVAL_MS);
  };
  tick();
}
