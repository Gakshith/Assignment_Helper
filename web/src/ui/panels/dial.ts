/**
 * The neatness dial. The centrepiece of the right panel and the one control the
 * product is actually about.
 *
 * TWO CLOCKS, ON PURPOSE. The thumb is written straight out of `pointermove` -- no
 * rAF gate, no await, no dependence on anything that touches the network. The render
 * behind it debounces 80-120 ms and will visibly lag the thumb. That is the design:
 * a dial that stutters to match the repaint feels broken even when the repaint is
 * fast, and a dial that waits for the server feels broken always. The page catching
 * up a tenth of a second later reads as the page catching up.
 *
 * Accessibility is not a later pass. It is `role="slider"` with a real
 * `aria-valuetext` that announces WORDS -- "careful", not "0.71" -- arrow, Page,
 * Home and End keys, a 24px target, and a focus ring that is never removed.
 */

import { el } from '../shell/dom';
import {
  NEATNESS_MAX,
  NEATNESS_MIN,
  clamp01,
  stepNeatness,
} from './neatness';

const THUMB_PX = 24;

export interface DialOptions {
  readonly id: string;
  /** The id of the element that names this slider. */
  readonly labelledBy: string;
  readonly poleLow: string;
  readonly poleHigh: string;
  /** Called on every interaction frame. Must be cheap: it runs inside pointermove. */
  readonly onInput: (value: number) => void;
  /** Called once when a drag or key interaction settles. */
  readonly onSettle: (value: number) => void;
  /** Words for the current value, for aria-valuetext. */
  readonly describe: (value: number) => string;
}

export class Dial {
  readonly root: HTMLElement;
  readonly #thumb: HTMLElement;
  #value: number;
  #interacting = false;
  #disabled = false;

  constructor(private readonly options: DialOptions, initial: number) {
    this.#value = clamp01(initial);

    this.#thumb = el('div', { class: 'dial__thumb' });
    const track = el('div', { class: 'dial__track' });
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => {
      const tick = el('div', { class: 'dial__tick' });
      tick.style.left = `calc(${THUMB_PX / 2}px + ${t} * (100% - ${THUMB_PX}px))`;
      return tick;
    });

    this.root = el('div', {
      class: 'dial',
      id: options.id,
      attrs: {
        role: 'slider',
        tabindex: '0',
        'aria-labelledby': options.labelledBy,
        'aria-valuemin': String(NEATNESS_MIN),
        'aria-valuemax': String(NEATNESS_MAX),
        'aria-orientation': 'horizontal',
      },
      children: [track, ...ticks, this.#thumb],
    });

    this.root.addEventListener('pointerdown', (event) => this.#onPointerDown(event));
    this.root.addEventListener('pointermove', (event) => this.#onPointerMove(event));
    this.root.addEventListener('pointerup', (event) => this.#onPointerUp(event));
    this.root.addEventListener('pointercancel', (event) => this.#onPointerUp(event));
    this.root.addEventListener('keydown', (event) => this.#onKeyDown(event));
    this.root.addEventListener('blur', () => {
      if (this.#interacting) this.#settle();
    });

    this.#paint();
    // The thumb position depends on the track width, which is not known until the
    // panel is laid out and changes with the window.
    new ResizeObserver(() => this.#paint()).observe(this.root);
  }

  get value(): number {
    return this.#value;
  }

  /** True while the user is dragging or keying. An external update must not yank
   *  the thumb out from under them mid-gesture. */
  get interacting(): boolean {
    return this.#interacting;
  }

  setDisabled(disabled: boolean): void {
    this.#disabled = disabled;
    this.root.setAttribute('aria-disabled', String(disabled));
    this.root.setAttribute('tabindex', disabled ? '-1' : '0');
  }

  /** Adopt a value from the document. Ignored while the user is mid-gesture. */
  adopt(value: number): void {
    if (this.#interacting) return;
    this.#value = clamp01(value);
    this.#paint();
  }

  // ------------------------------------------------------------------ internals

  #usableWidth(): number {
    return Math.max(1, this.root.clientWidth - THUMB_PX);
  }

  /** The only DOM write in the drag loop: one transform, on a composited layer. */
  #paint(): void {
    this.#thumb.style.transform = `translateX(${this.#value * this.#usableWidth()}px)`;
    this.root.setAttribute('aria-valuenow', this.#value.toFixed(3));
    this.root.setAttribute('aria-valuetext', this.options.describe(this.#value));
  }

  #valueAt(clientX: number): number {
    const rect = this.root.getBoundingClientRect();
    return clamp01((clientX - rect.left - THUMB_PX / 2) / this.#usableWidth());
  }

  #apply(value: number): void {
    this.#value = clamp01(value);
    this.#paint();
    this.options.onInput(this.#value);
  }

  #settle(): void {
    this.#interacting = false;
    this.options.onSettle(this.#value);
  }

  #onPointerDown(event: PointerEvent): void {
    if (this.#disabled) return;
    // Drag anywhere on the track, including the first click: the value jumps to the
    // pointer rather than requiring the thumb to be grabbed first.
    this.#interacting = true;
    this.root.setPointerCapture(event.pointerId);
    this.root.focus();
    this.#apply(this.#valueAt(event.clientX));
    event.preventDefault();
  }

  #onPointerMove(event: PointerEvent): void {
    if (!this.#interacting) return;
    this.#apply(this.#valueAt(event.clientX));
  }

  #onPointerUp(event: PointerEvent): void {
    if (!this.#interacting) return;
    if (this.root.hasPointerCapture(event.pointerId)) {
      this.root.releasePointerCapture(event.pointerId);
    }
    this.#settle();
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (this.#disabled) return;
    const next = stepNeatness(this.#value, event.key, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    this.#interacting = true;
    this.#apply(next);
    // A key press is its own complete gesture; there is no keyup to wait for.
    this.#settle();
  }
}
