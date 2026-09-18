/**
 * The style panel: the permanent right column, and the home of the neatness dial.
 *
 * It is not a drawer and not a popover. The one control the product is about does
 * not hide behind a menu, and everything below it is deliberately quieter.
 *
 * Invariant I4: every change is posted to the server and the panel believes the
 * snapshot that comes back. Nothing is mutated locally and hoped for.
 * Invariant I5: every failed call is on screen -- in this panel's status line, and
 * in the app banner when it is a fault rather than a state.
 */

import type { StylePanel } from '../../app/contracts';
import { el, svg } from '../shell/dom';
import { setDocumentTitle } from '../shell/chrome';
import { clearLocal, raiseLocal } from '../shell/problems';
import type { ApiError } from '../shell/session';
import { Dial } from './dial';
import {
  NEATNESS_PARAMS,
  NEATNESS_POLE_HIGH,
  NEATNESS_POLE_LOW,
  detach,
  effectiveAmplitude,
  isDetached,
  neatnessValueText,
  neatnessWord,
  reattach,
  type NeatnessParam,
} from './neatness';
import { StyleClient, type LoadedDocument } from './style-client';
import {
  DEFAULT_STYLE,
  PAGE_SIZES_UI,
  PAPER_KINDS,
  RULINGS,
  withHand,
  withPaper,
  type PaperKind,
  type ResolvedStyle,
} from './style-model';

const CHEVRON =
  '<svg viewBox="0 0 12 12"><path d="M4 2l4 4-4 4"></path></svg>';

const PAPER_LABEL: Record<PaperKind, string> = {
  ruled: 'Ruled',
  plain: 'Plain',
  grid: 'Grid',
  rough: 'Rough',
};

const RULING_LABEL: Record<string, string> = {
  college: 'College — 7.1 mm',
  wide: 'Wide — 8.7 mm',
  grid5: 'Grid — 5 mm',
};

const PAGE_LABEL: Record<string, string> = {
  letter: 'US Letter — 215.9 × 279.4 mm',
  a4: 'A4 — 210 × 297 mm',
  legal: 'US Legal — 215.9 × 355.6 mm',
};

/** `document.none-open` is a STATE, not a fault: no file has been opened yet. It is
 *  reported in this panel and in the top bar, and deliberately not escalated to the
 *  app banner, which exists for things that are actually wrong. */
const NOT_A_FAULT = new Set(['document.none-open']);

function row(label: string, aside: HTMLElement | null, control: HTMLElement): HTMLElement {
  const head = el('div', { class: 'row__head', children: [el('span', { class: 'row__label', text: label })] });
  if (aside) head.append(aside);
  return el('div', { class: 'row', children: [head, control] });
}

class Knob {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  readonly #value: HTMLElement;
  readonly #reattach: HTMLButtonElement;

  constructor(
    readonly param: NeatnessParam,
    onDetach: (value: number) => void,
    onReattach: () => void,
  ) {
    this.input = el('input', {
      class: 'slider',
      id: `knob-${param.id}`,
      attrs: {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.01',
        'aria-describedby': `knob-${param.id}-hint`,
      },
    });
    this.#value = el('span', { class: 'knob__value' });
    this.#reattach = el('button', {
      class: 'knob__reattach',
      id: `reattach-${param.id}`,
      text: 'follow the dial',
      attrs: { type: 'button' },
    });

    this.input.addEventListener('input', () => onDetach(Number(this.input.value)));
    this.#reattach.addEventListener('click', onReattach);

    const name = el('span', { class: 'knob__name', text: param.label });
    const dot = el('span', {
      class: 'knob__dot',
      attrs: { role: 'img', 'aria-label': 'set independently of the dial' },
    });

    this.root = el('div', {
      class: 'knob',
      attrs: { 'data-detached': 'false' },
      children: [
        el('div', {
          class: 'knob__head',
          children: [dot, name, el('span', { class: 'knob__spacer' }), this.#value, this.#reattach],
        }),
        this.input,
        el('div', {
          class: 'row__aside',
          id: `knob-${param.id}-hint`,
          text: param.hint,
        }),
      ],
    });
  }

  render(style: ResolvedStyle, disabled: boolean): void {
    const detached = isDetached(style.hand.overrides, this.param.id);
    const amplitude = effectiveAmplitude(style.hand.neatness, this.param, style.hand.overrides);
    this.root.dataset['detached'] = String(detached);
    this.#value.textContent = detached ? amplitude.toFixed(2) : `${amplitude.toFixed(2)} · dial`;
    this.#reattach.disabled = disabled;
    this.input.disabled = disabled;
    if (document.activeElement !== this.input) this.input.value = String(amplitude);
  }
}

class DraftingStylePanel implements StylePanel {
  readonly name = 'drafting-style-panel';

  #style: ResolvedStyle = DEFAULT_STYLE;
  #ready = false;
  #dial: Dial | null = null;
  #knobs: Knob[] = [];
  #client = new StyleClient();

  #status: HTMLElement | null = null;
  #word: HTMLElement | null = null;
  #detachNote: HTMLElement | null = null;
  #kindButtons: HTMLButtonElement[] = [];
  #ruling: HTMLSelectElement | null = null;
  #pageSize: HTMLSelectElement | null = null;
  #tint: HTMLInputElement | null = null;
  #tintText: HTMLElement | null = null;
  #ink: HTMLInputElement | null = null;
  #inkText: HTMLElement | null = null;
  #size: HTMLInputElement | null = null;
  #sizeText: HTMLElement | null = null;
  #slant: HTMLInputElement | null = null;
  #slantText: HTMLElement | null = null;

  mount(host: HTMLElement): void {
    host.replaceChildren(
      el('div', {
        class: 'panel__scroll',
        children: [this.#statusLine(), this.#neatnessSection(), this.#paperSection(), this.#handSection()],
      }),
    );

    this.#client.onAdopted((doc) => this.#adopt(doc));
    this.#client.onFailed((err) => this.#fail(err));
    this.#render();
    this.#say('Loading the document’s style…', 'info');
    void this.#client.load();
  }

  // ------------------------------------------------------------------ sections

  #statusLine(): HTMLElement {
    const status = el('div', {
      class: 'panel__status',
      id: 'panel-status',
      attrs: { role: 'status' },
    });
    this.#status = status;
    return status;
  }

  #neatnessSection(): HTMLElement {
    const label = el('span', {
      class: 'dial__label',
      id: 'dial-neatness-label',
      text: 'How neat is this hand?',
    });
    this.#word = el('b', { id: 'dial-neatness-word', text: neatnessWord(this.#style.hand.neatness) });
    const reading = el('div', {
      class: 'dial__reading',
      children: [document.createTextNode('Writing like '), this.#word],
    });

    const dial = new Dial(
      {
        id: 'dial-neatness',
        labelledBy: 'dial-neatness-label',
        poleLow: NEATNESS_POLE_LOW,
        poleHigh: NEATNESS_POLE_HIGH,
        describe: (value) => neatnessValueText(value, this.#style.hand.overrides),
        // 60fps path: local state and the readout only. No await, no network.
        onInput: (value) => this.#dialInput(value),
        onSettle: (value) => this.#dialInput(value),
      },
      this.#style.hand.neatness,
    );
    this.#dial = dial;

    const poles = el('div', {
      class: 'dial__poles',
      children: [
        el('span', { text: NEATNESS_POLE_LOW }),
        el('span', { text: NEATNESS_POLE_HIGH }),
      ],
    });

    this.#knobs = NEATNESS_PARAMS.map(
      (param) =>
        new Knob(
          param,
          (value) => this.#detachKnob(param, value),
          () => this.#reattachKnob(param),
        ),
    );

    this.#detachNote = el('p', {
      class: 'adv__note',
      text:
        'These five move together in a real hand, which is why one dial drives them. ' +
        'Move one and it detaches: a dot marks it, and it stops following the dial until you send it back.',
    });

    const summary = el('summary', {
      children: [svg(CHEVRON, 'adv__chevron'), document.createTextNode('Advanced — the five it drives')],
    });
    const details = el('details', {
      class: 'adv',
      id: 'adv-neatness',
      children: [
        summary,
        this.#detachNote,
        el('div', { class: 'adv__list', children: this.#knobs.map((k) => k.root) }),
      ],
    });

    return el('section', {
      class: 'sect sect--hero',
      id: 'sect-neatness',
      children: [
        el('h2', { class: 'sect__head', text: 'Neatness' }),
        label,
        reading,
        dial.root,
        poles,
        details,
      ],
    });
  }

  #paperSection(): HTMLElement {
    this.#kindButtons = PAPER_KINDS.map((kind) => {
      const button = el('button', {
        class: 'seg__btn',
        id: `paper-kind-${kind}`,
        text: PAPER_LABEL[kind],
        attrs: { type: 'button', 'aria-pressed': 'false' },
      });
      button.addEventListener('click', () => this.#edit(withPaper(this.#style, { kind })));
      return button;
    });

    this.#ruling = this.#select('paper-ruling', RULINGS, RULING_LABEL, (value) =>
      this.#edit(withPaper(this.#style, { ruling: value as 'college' | 'wide' | 'grid5' })),
    );
    this.#pageSize = this.#select('page-size', PAGE_SIZES_UI, PAGE_LABEL, (value) =>
      this.#edit(withPaper(this.#style, { page_size: value as 'letter' | 'a4' | 'legal' })),
    );

    this.#tintText = el('span', { class: 'row__aside u-mono' });
    this.#tint = this.#colour('paper-tint', (value) => this.#edit(withPaper(this.#style, { tint: value })));

    return el('section', {
      class: 'sect',
      id: 'sect-paper',
      children: [
        el('h2', { class: 'sect__head', text: 'Paper' }),
        row(
          'Surface',
          null,
          el('div', {
            class: 'seg',
            attrs: { role: 'group', 'aria-label': 'Paper surface' },
            children: this.#kindButtons,
          }),
        ),
        row('Ruling', null, this.#ruling),
        row('Page size', null, this.#pageSize),
        row(
          'Tint',
          null,
          el('div', { class: 'ctl-pair', children: [this.#tint, this.#tintText] }),
        ),
      ],
    });
  }

  #handSection(): HTMLElement {
    this.#inkText = el('span', { class: 'row__aside u-mono' });
    this.#ink = this.#colour('ink-colour', (value) =>
      this.#edit(withHand(this.#style, { ink_colour: value })),
    );

    this.#sizeText = el('span', { class: 'row__aside u-mono' });
    this.#size = this.#range('hand-size', 2.5, 7, 0.1, (value) =>
      this.#edit(withHand(this.#style, { size_mm: value })),
    );

    this.#slantText = el('span', { class: 'row__aside u-mono' });
    this.#slant = this.#range('hand-slant', -20, 20, 0.5, (value) =>
      this.#edit(withHand(this.#style, { slant_deg: value })),
    );

    return el('section', {
      class: 'sect',
      id: 'sect-hand',
      children: [
        el('h2', { class: 'sect__head', text: 'Hand' }),
        row('Ink', null, el('div', { class: 'ctl-pair', children: [this.#ink, this.#inkText] })),
        row('Size', this.#sizeText, this.#size),
        row('Slant', this.#slantText, this.#slant),
      ],
    });
  }

  // ------------------------------------------------------------------ controls

  #select(
    id: string,
    values: readonly string[],
    labels: Readonly<Record<string, string>>,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const select = el('select', { class: 'ctl', id });
    for (const value of values) {
      const option = el('option', { text: labels[value] ?? value });
      option.value = value;
      select.append(option);
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  #colour(id: string, onChange: (value: string) => void): HTMLInputElement {
    const input = el('input', { class: 'ctl', id, attrs: { type: 'color' } });
    input.addEventListener('input', () => onChange(input.value.toUpperCase()));
    return input;
  }

  #range(
    id: string,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
  ): HTMLInputElement {
    const input = el('input', {
      class: 'slider',
      id,
      attrs: { type: 'range', min: String(min), max: String(max), step: String(step) },
    });
    input.addEventListener('input', () => onChange(Number(input.value)));
    return input;
  }

  // -------------------------------------------------------------------- edits

  /** The 60fps half. Local state and readouts now; the POST is the client's problem. */
  #dialInput(value: number): void {
    this.#style = withHand(this.#style, { neatness: value });
    if (this.#word) this.#word.textContent = neatnessWord(value);
    for (const knob of this.#knobs) knob.render(this.#style, !this.#ready);
    if (this.#ready) this.#client.commit(this.#style);
  }

  #detachKnob(param: NeatnessParam, value: number): void {
    this.#edit(
      withHand(this.#style, { overrides: detach(this.#style.hand.overrides, param.id, value) }),
    );
  }

  #reattachKnob(param: NeatnessParam): void {
    this.#edit(withHand(this.#style, { overrides: reattach(this.#style.hand.overrides, param.id) }));
  }

  #edit(next: ResolvedStyle): void {
    this.#style = next;
    this.#render();
    if (this.#ready) this.#client.commit(next);
  }

  // ------------------------------------------------------------------- server

  #adopt(doc: LoadedDocument): void {
    this.#ready = true;
    this.#style = doc.style;
    setDocumentTitle(doc.title);
    clearLocal('style.write-failed');
    this.#render();
    this.#hide();
  }

  #fail(err: ApiError): void {
    this.#ready = false;
    this.#render();
    this.#say(err.message, 'warn', err.code);
    if (NOT_A_FAULT.has(err.code)) {
      setDocumentTitle(null);
      return;
    }
    raiseLocal({
      scope: 'app',
      code: 'style.write-failed',
      message: `The style panel could not reach the document: ${err.message}`,
      detail: `${err.code}${err.status > 0 ? ` (HTTP ${err.status})` : ''}${err.detail ? ` — ${err.detail}` : ''}`,
    });
  }

  #say(message: string, tone: 'info' | 'warn', code?: string): void {
    const status = this.#status;
    if (!status) return;
    status.hidden = false;
    status.dataset['tone'] = tone;
    const body = el('div', { children: [document.createTextNode(message)] });
    if (code !== undefined) {
      body.append(el('div', { children: [el('code', { text: code })] }));
    }
    status.replaceChildren(body);
  }

  #hide(): void {
    if (!this.#status) return;
    this.#status.hidden = true;
    this.#status.replaceChildren();
  }

  // ------------------------------------------------------------------- render

  /** Writes the whole panel from `#style`. Never overwrites a focused control --
   *  a snapshot landing mid-gesture must not fight the user for the pointer. */
  #render(): void {
    const style = this.#style;
    const disabled = !this.#ready;

    this.#dial?.adopt(style.hand.neatness);
    this.#dial?.setDisabled(disabled);
    if (this.#word) this.#word.textContent = neatnessWord(style.hand.neatness);
    for (const knob of this.#knobs) knob.render(style, disabled);

    for (const [index, kind] of PAPER_KINDS.entries()) {
      const button = this.#kindButtons[index];
      if (!button) continue;
      button.setAttribute('aria-pressed', String(style.paper.kind === kind));
      button.disabled = disabled;
    }

    // Ruling describes a ruled or grid surface. On plain or rough it has nothing to
    // describe, so it is disabled WITH A REASON rather than silently ignored.
    const rulingApplies = style.paper.kind === 'ruled' || style.paper.kind === 'grid';
    if (this.#ruling) {
      this.#ruling.disabled = disabled || !rulingApplies;
      this.#ruling.title = rulingApplies
        ? ''
        : `A ${style.paper.kind} surface has no ruling to set.`;
      if (document.activeElement !== this.#ruling) this.#ruling.value = style.paper.ruling;
    }
    if (this.#pageSize) {
      this.#pageSize.disabled = disabled;
      if (document.activeElement !== this.#pageSize) this.#pageSize.value = style.paper.page_size;
    }
    this.#paintColour(this.#tint, this.#tintText, style.paper.tint, disabled);
    this.#paintColour(this.#ink, this.#inkText, style.hand.ink_colour, disabled);

    if (this.#size) {
      this.#size.disabled = disabled;
      if (document.activeElement !== this.#size) this.#size.value = String(style.hand.size_mm);
    }
    if (this.#sizeText) this.#sizeText.textContent = `${style.hand.size_mm.toFixed(1)} mm`;
    if (this.#slant) {
      this.#slant.disabled = disabled;
      if (document.activeElement !== this.#slant) this.#slant.value = String(style.hand.slant_deg);
    }
    if (this.#slantText) this.#slantText.textContent = `${style.hand.slant_deg.toFixed(1)}°`;
  }

  #paintColour(
    input: HTMLInputElement | null,
    text: HTMLElement | null,
    value: string,
    disabled: boolean,
  ): void {
    if (input) {
      input.disabled = disabled;
      if (document.activeElement !== input) input.value = value.toLowerCase();
    }
    if (text) text.textContent = value.toUpperCase();
  }
}

export const draftingStylePanel: StylePanel = new DraftingStylePanel();
