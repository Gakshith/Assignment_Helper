// OWNER: the lasso strand. Replace the export; do not touch main.ts.
/**
 * Box selection over the rendered page, and the four-action toolbar.
 *
 * This plus block-scoped chat are §B.2's #1 and #2 differentiators — zero competitors
 * have either — and in the original plan they were one strand of five sharing a
 * 10-14 day phase.
 *
 * The user chose **lasso box selection** over freehand. That is why this is a drag
 * rectangle: a freehand path over a page of handwriting selects ambiguously, and the
 * user has to be able to predict what a gesture will grab.
 */

import type { LassoController } from '../../app/contracts';
import type { DocumentGeometry } from '../../render/geometry';
import type { Mm, RectMm } from '../../render/units';
import { SpatialIndex } from './spatial';
import { placeToolbar, toolbarState, type ToolbarAction } from './toolbar';

const TOP_BAR_H = 48;

export interface LassoHooks {
  onSelect(blockIds: readonly string[]): void;
  onAction(action: ToolbarAction, blockIds: readonly string[]): void;
}

export class Lasso implements LassoController {
  readonly name = 'lasso';
  readonly #index = new SpatialIndex();
  #host: HTMLElement | null = null;
  #box: HTMLElement | null = null;
  #toolbar: HTMLElement | null = null;
  #selected: string[] = [];
  #dragFrom: { x: number; y: number; page: number } | null = null;

  constructor(private readonly hooks: LassoHooks) {}

  /** Called whenever geometry changes. Cheap: rebuilding 20 pages is a few ms. */
  setGeometry(geometry: DocumentGeometry | null): void {
    this.#index.rebuild(geometry?.pages ?? []);
  }

  mount(host: HTMLElement): void {
    this.#host = host;
    host.addEventListener('pointerdown', this.#onDown);
    host.addEventListener('pointermove', this.#onMove);
    host.addEventListener('pointerup', this.#onUp);
    host.addEventListener('pointercancel', this.#onUp);
  }

  hitTest(xMm: Mm, yMm: Mm, pageIndex: number): string | null {
    return this.#index.hitTest(xMm, yMm, pageIndex);
  }

  hitTestRect(rect: RectMm, pageIndex: number): readonly string[] {
    return this.#index.hitTestRect(rect, pageIndex);
  }

  // ------------------------------------------------------------ pointer handling

  #pageOf(target: EventTarget | null): { el: HTMLElement; index: number } | null {
    const el = (target as HTMLElement | null)?.closest?.('.page') as HTMLElement | null;
    if (!el) return null;
    const raw = el.dataset['pageIndex'];
    if (raw === undefined) {
      // I5: a page element without its index is a wiring fault, not something to
      // silently ignore into "nothing is selectable".
      throw new Error('a .page element is missing data-page-index');
    }
    return { el, index: Number(raw) };
  }

  /** Viewport px -> page mm. The page element is sized in mm by the kernel. */
  #toMm(el: HTMLElement, clientX: number, clientY: number): { xMm: Mm; yMm: Mm } {
    const r = el.getBoundingClientRect();
    const widthMm = el.offsetWidth === 0 ? 0 : (r.width / el.offsetWidth) * el.offsetWidth;
    // The canvas CSS size is set in mm, so px-per-mm is simply rect width / mm width.
    const mmWidth = parseFloat(getComputedStyle(el).getPropertyValue('--page-w-mm') || '215.9');
    const scale = r.width / (mmWidth || widthMm || 215.9);
    return { xMm: (clientX - r.left) / scale, yMm: (clientY - r.top) / scale };
  }

  #onDown = (ev: PointerEvent): void => {
    const page = this.#pageOf(ev.target);
    if (!page) return;
    const { xMm, yMm } = this.#toMm(page.el, ev.clientX, ev.clientY);

    const hit = this.hitTest(xMm, yMm, page.index);
    if (hit && !ev.shiftKey) {
      this.#setSelection([hit]);
      this.#showToolbar();
      return;
    }

    this.#dragFrom = { x: ev.clientX, y: ev.clientY, page: page.index };
    this.#ensureBox();
    this.#hideToolbar();
  };

  #onMove = (ev: PointerEvent): void => {
    if (!this.#dragFrom || !this.#box) return;
    const left = Math.min(this.#dragFrom.x, ev.clientX);
    const top = Math.min(this.#dragFrom.y, ev.clientY);
    this.#box.style.left = `${left}px`;
    this.#box.style.top = `${top}px`;
    this.#box.style.width = `${Math.abs(ev.clientX - this.#dragFrom.x)}px`;
    this.#box.style.height = `${Math.abs(ev.clientY - this.#dragFrom.y)}px`;
    this.#box.hidden = false;
  };

  #onUp = (ev: PointerEvent): void => {
    if (!this.#dragFrom) return;
    const from = this.#dragFrom;
    this.#dragFrom = null;
    if (this.#box) this.#box.hidden = true;

    const page = this.#pageOf(ev.target) ?? this.#pageOf(document.querySelector('.page'));
    if (!page) return;

    const a = this.#toMm(page.el, from.x, from.y);
    const b = this.#toMm(page.el, ev.clientX, ev.clientY);
    const rect: RectMm = {
      xMm: Math.min(a.xMm, b.xMm),
      yMm: Math.min(a.yMm, b.yMm),
      wMm: Math.abs(b.xMm - a.xMm),
      hMm: Math.abs(b.yMm - a.yMm),
    };
    if (rect.wMm < 1 && rect.hMm < 1) {
      this.#setSelection([]);
      this.#hideToolbar();
      return;
    }
    this.#setSelection([...this.hitTestRect(rect, page.index)]);
    if (this.#selected.length) this.#showToolbar();
  };

  #setSelection(ids: string[]): void {
    this.#selected = ids;
    this.hooks.onSelect(ids);
  }

  // ------------------------------------------------------------ chrome

  #ensureBox(): void {
    if (this.#box || !this.#host) return;
    const box = document.createElement('div');
    box.className = 'lasso-box';
    box.hidden = true;
    document.body.append(box);
    this.#box = box;
  }

  #hideToolbar(): void {
    if (this.#toolbar) this.#toolbar.hidden = true;
  }

  #showToolbar(): void {
    if (!this.#host) return;
    if (!this.#toolbar) {
      const bar = document.createElement('div');
      bar.className = 'sel-toolbar';
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Selection actions');
      document.body.append(bar);
      this.#toolbar = bar;
    }
    const bar = this.#toolbar;
    bar.replaceChildren();

    for (const item of toolbarState(this.#selected.length).actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sel-pill';
      btn.id = `sel-${item.action}`;
      btn.textContent = { ask: 'Ask', edit: 'Edit', restyle: 'Restyle', reroll: 'Re-roll' }[
        item.action
      ];
      btn.disabled = !item.enabled;
      if (item.reason) btn.title = item.reason;
      btn.addEventListener('click', () => this.hooks.onAction(item.action, this.#selected));
      bar.append(btn);
    }

    bar.hidden = false;
    const sel = this.#selectionRect();
    if (!sel) return;
    const p = placeToolbar({
      selection: sel,
      toolbar: { width: bar.offsetWidth || 260, height: bar.offsetHeight || 36 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      topBarH: TOP_BAR_H,
    });
    bar.style.left = `${p.left}px`;
    bar.style.top = `${p.top}px`;
    bar.dataset['below'] = String(p.below);
  }

  #selectionRect(): { left: number; top: number; width: number; height: number } | null {
    if (!this.#selected.length || !this.#host) return null;
    const pageEl = this.#host.querySelector('.page') as HTMLElement | null;
    if (!pageEl) return null;
    const r = pageEl.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
}

/** The stub stays until the kernel can hand us geometry; see main.ts. */
export const lassoController: LassoController = new Lasso({
  onSelect: () => {},
  onAction: () => {},
});

export { placeToolbar, toolbarState } from './toolbar';
export { SpatialIndex } from './spatial';
