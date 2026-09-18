/**
 * Behaviour for the static chrome in web/index.html.
 *
 * The markup is static so the frame renders, reads and keyboard-navigates before any
 * module runs; this file only attaches behaviour and fills the two regions that are
 * data-driven, the bypass badges and the problem banner.
 */

import { MM_PER_INCH } from '../../render/units';
import { mountBanner } from './banner';
import { bridgeToKernel, raiseLocal } from './problems';
import { deriveBadges, fetchStatus, StatusShapeError, type Badge } from './status';
import { ApiError } from './session';
import { wireThemeToggle } from './theme';

/** CSS defines 1mm as exactly 1/25.4in and 1in as exactly 96px. Not a guess. */
const CSS_DPI = 96;

function need<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`the shell is missing #${id}; web/index.html and the shell disagree`);
  return el as T;
}

// ------------------------------------------------------------------- badges

function badgeElement(badge: Badge): HTMLElement {
  const el = document.createElement('span');
  el.className = badge.kind === 'dev' ? 'badge badge--dev' : 'badge';
  el.id = `badge-${badge.id}`;
  el.textContent = badge.label;
  el.title = badge.title;
  return el;
}

async function paintBadges(host: HTMLElement): Promise<void> {
  let raw: unknown;
  try {
    raw = await fetchStatus();
  } catch (err) {
    // I15 read the other way round: if the bypass state cannot be read, the honest
    // report is "unknown", never "none". Silence here would let the user sit in a
    // bypass believing they are not in one.
    const isApi = err instanceof ApiError;
    host.replaceChildren(
      badgeElement({
        id: 'status-unknown',
        kind: 'bypass',
        label: 'bypasses unknown',
        title: 'The server did not answer /api/status, so active bypasses cannot be listed.',
      }),
    );
    raiseLocal({
      scope: 'app',
      code: 'status.unreadable',
      message:
        'Could not read /api/status, so active bypasses and the dev-build flag are unknown. ' +
        'Assume nothing about which guards are on.',
      detail: isApi ? `${err.code}: ${err.message}` : String(err),
    });
    return;
  }

  try {
    host.replaceChildren(...deriveBadges(raw).map(badgeElement));
  } catch (err) {
    if (!(err instanceof StatusShapeError)) throw err;
    host.replaceChildren(
      badgeElement({
        id: 'status-malformed',
        kind: 'bypass',
        label: 'bypasses unknown',
        title: 'The server answered /api/status in a shape this build does not understand.',
      }),
    );
    raiseLocal({
      scope: 'app',
      code: 'status.malformed',
      message: 'The server answered /api/status in a shape this build does not understand.',
      detail: err.message,
    });
  }
}

// --------------------------------------------------------------------- rail

interface RailTarget {
  readonly id: string;
  /** A section in the style panel, or null to mean the page column itself. */
  readonly section: string | null;
  readonly unavailable?: string;
}

const RAIL_TARGETS: readonly RailTarget[] = [
  { id: 'rail-document', section: null },
  { id: 'rail-paper', section: 'sect-paper' },
  { id: 'rail-hand', section: 'sect-neatness' },
  {
    id: 'rail-figures',
    section: null,
    unavailable: 'Figure controls arrive with the figures strand.',
  },
];

function wireRail(rail: HTMLElement, panel: HTMLElement): void {
  const items: HTMLButtonElement[] = [];
  for (const target of RAIL_TARGETS) {
    const button = document.getElementById(target.id);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`the shell is missing rail item #${target.id}`);
    }
    items.push(button);
    if (target.unavailable !== undefined) {
      button.disabled = true;
      button.title = target.unavailable;
      continue;
    }
    button.addEventListener('click', () => {
      for (const other of items) other.setAttribute('aria-current', 'false');
      button.setAttribute('aria-current', 'true');
      if (target.section === null) {
        document.getElementById('pages')?.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const section = document.getElementById(target.section);
      if (!section) {
        // The panel is mounted by the kernel; before that lands there is nothing to
        // scroll to, and pretending the click worked would be a lie.
        button.title = 'The style panel has not mounted yet.';
        return;
      }
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      panel.focus({ preventScroll: true });
    });
  }

  const pin = document.getElementById('rail-pin');
  if (!(pin instanceof HTMLButtonElement)) throw new Error('the shell is missing #rail-pin');
  pin.addEventListener('click', () => {
    const pinned = rail.dataset['pinned'] === 'true';
    rail.dataset['pinned'] = String(!pinned);
    pin.setAttribute('aria-pressed', String(!pinned));
  });
}

// --------------------------------------------------------------------- dock

function wireDock(): void {
  const dock = need('dock');
  const toggle = need<HTMLButtonElement>('dock-toggle');
  const label = need('dock-toggle-label');
  toggle.addEventListener('click', () => {
    const open = dock.dataset['open'] === 'true';
    dock.dataset['open'] = String(!open);
    toggle.setAttribute('aria-expanded', String(!open));
    label.textContent = open ? 'Open' : 'Close';
  });
}

// --------------------------------------------------------------- page fitting

/**
 * The page is centred, never wider than --page-max, and always has real margins.
 * `zoom` rather than `transform: scale()` because zoom affects layout, so the scroll
 * height stays honest and the page below does not overlap the one above.
 */
export function pageZoom(naturalPx: number, availablePx: number, maxPx: number): number {
  if (!(naturalPx > 0)) return 1;
  return Math.min(1, Math.min(maxPx, availablePx) / naturalPx);
}

function naturalPageWidthPx(page: HTMLElement): number | null {
  const paper = page.querySelector<HTMLElement>('.page-layer--paper');
  if (!paper) return null;
  const mm = Number.parseFloat(paper.style.width);
  if (!Number.isFinite(mm) || mm <= 0) return null;
  return (mm / MM_PER_INCH) * CSS_DPI;
}

function fitPages(pages: HTMLElement): void {
  const first = pages.querySelector<HTMLElement>('.page');
  if (!first) return;
  const natural = naturalPageWidthPx(first);
  if (natural === null) return;
  const style = getComputedStyle(pages);
  const available =
    pages.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
  const max = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--page-max'));
  pages.style.setProperty(
    '--page-zoom',
    String(pageZoom(natural, available, Number.isFinite(max) ? max : 720)),
  );
}

function watchPages(pages: HTMLElement): void {
  const run = (): void => fitPages(pages);
  new ResizeObserver(run).observe(pages);
  // Pages are created by the kernel's registry long after this module runs, and
  // exactly once each (invariant I13), so a mutation observer is the only signal.
  new MutationObserver(run).observe(pages, { childList: true });
  run();
}

// --------------------------------------------------------------------- mount

export function mountChrome(): void {
  wireThemeToggle(need<HTMLButtonElement>('theme-toggle'), need('theme-toggle-label'));
  mountBanner(need('app-banner'));
  bridgeToKernel();
  wireRail(need('rail'), need('right-panel'));
  wireDock();
  watchPages(need('pages'));

  const exportButton = need<HTMLButtonElement>('export-pdf');
  // The ExportController is constructed by the frozen kernel and is not reachable
  // from any UI seam, so this button is honestly dead rather than fake-alive.
  exportButton.disabled = true;
  exportButton.title = 'Export is wired by the export strand, which has not landed.';

  void paintBadges(need('bypass-badges'));
}

/** The document title in the top bar. Called by the style panel, which owns the load. */
export function setDocumentTitle(title: string | null): void {
  const el = document.getElementById('doc-title');
  if (!el) return;
  el.textContent = title && title.length > 0 ? title : 'untitled document';
}
