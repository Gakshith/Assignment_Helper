/**
 * The app-scope problem banner (invariant I5).
 *
 * Block-scope problems are the paint/overlay strand's badges on the page itself and
 * are deliberately NOT duplicated here. What this owns is the class of failure that
 * has no page to sit on -- a dead server, a rejected delta, a bypass that could not
 * be read -- and it puts them where they cannot be scrolled past: full width, pinned
 * under the top bar, `aria-live="assertive"`.
 */

import type { Problem } from '../../types/document';
import { onProblems } from './problems';

const WARNING_ICON =
  '<svg class="banner__icon" viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M10 2.5 18.5 17h-17z"></path><path d="M10 8v4"></path>' +
  '<circle cx="10" cy="14.6" r="0.4"></circle></svg>';

function row(problem: Problem): HTMLElement {
  const el = document.createElement('div');
  el.className = 'banner__row';
  el.insertAdjacentHTML('afterbegin', WARNING_ICON);

  const body = document.createElement('div');
  body.className = 'banner__body';

  const message = document.createElement('div');
  message.className = 'banner__msg';
  message.textContent = problem.message;
  body.append(message);

  const meta = document.createElement('div');
  meta.className = 'banner__meta';
  meta.textContent = problem.detail ? `${problem.code} — ${problem.detail}` : problem.code;
  body.append(meta);

  el.append(body);
  return el;
}

export function mountBanner(host: HTMLElement): void {
  const surface = document.createElement('div');
  surface.className = 'banner';
  host.append(surface);

  onProblems((all) => {
    const appScope = all.filter((p) => p.scope === 'app');
    host.dataset['count'] = String(appScope.length);
    surface.replaceChildren(...appScope.map(row));
  });
}
