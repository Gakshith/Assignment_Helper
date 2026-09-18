/**
 * The chat dock. Differentiator #1: the unit of conversation is a SELECTION, not the
 * whole document.
 *
 * Bottom-docked at 44px, expanding to 360px, never a permanent third column (§B.4).
 */

import type { ChatPanel, EditorActions } from '../../app/contracts';
import { ask, type ChatEvent } from './transport';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class DockedChatPanel implements ChatPanel {
  readonly name = 'chat';
  #actions: EditorActions | null = null;
  #log: HTMLElement | null = null;
  #input: HTMLTextAreaElement | null = null;
  #scope: HTMLElement | null = null;
  #selected: readonly string[] = [];
  #busy = false;
  #abort: AbortController | null = null;

  constructor(private readonly token: string | null) {}

  mount(host: HTMLElement, actions: EditorActions): void {
    this.#actions = actions;
    host.replaceChildren();
    host.classList.add('chat-dock');

    const bar = el('div', 'chat-bar');
    this.#scope = el('span', 'chat-scope', 'the whole page');
    const scopeLabel = el('span', 'chat-scope-label', 'Asking about');
    bar.append(scopeLabel, this.#scope);
    host.append(bar);

    this.#log = el('div', 'chat-log');
    host.append(this.#log);

    const form = el('form', 'chat-form');
    this.#input = document.createElement('textarea');
    this.#input.className = 'chat-input';
    this.#input.id = 'chat-input';
    this.#input.rows = 1;
    this.#input.placeholder = 'Ask about the selected work…';
    const send = el('button', 'chat-send', 'Ask');
    send.setAttribute('type', 'submit');
    form.append(this.#input, send);
    host.append(form);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const q = this.#input?.value.trim();
      if (q) void this.askAboutSelection(this.#selected, q);
    });
    this.#input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        form.requestSubmit();
      }
    });

    actions.selection.onChange((ids) => {
      this.#selected = ids;
      this.#renderScope();
    });

    // The toolbar's Ask pill routes here rather than the lasso importing this panel.
    actions.onAskRequested((ids) => {
      this.#selected = ids;
      this.#renderScope();
      host.classList.add('chat-dock--open');
      this.#input?.focus();
    });
  }

  #renderScope(): void {
    if (!this.#scope) return;
    const n = this.#selected.length;
    this.#scope.textContent =
      n === 0 ? 'the whole page' : n === 1 ? '1 selected block' : `${n} selected blocks`;
  }

  #append(cls: string, text: string): HTMLElement {
    const line = el('div', `chat-line chat-line--${cls}`, text);
    this.#log?.append(line);
    this.#log?.scrollTo({ top: this.#log.scrollHeight });
    return line;
  }

  async askAboutSelection(blockIds: readonly string[], question: string): Promise<void> {
    if (this.#busy) {
      // Row 20: a second send must not silently interleave two streams into one answer.
      this.#abort?.abort();
    }
    this.#busy = true;
    this.#abort = new AbortController();
    if (this.#input) this.#input.value = '';

    this.#append('you', question);

    /**
     * Send the work AS IT LOOKS, not a transcription of it. This is differentiator #2:
     * asking "is step 3 right?" about a picture of the page is a different question
     * from asking it about a string, and the string is what every competitor sends.
     */
    let crop: Awaited<ReturnType<EditorActions['cropSelection']>> = null;
    if (blockIds.length > 0 && this.#actions) {
      try {
        crop = await this.#actions.cropSelection(blockIds);
      } catch (err) {
        // Not swallowed: the question still goes, but the user is told it went without
        // the image rather than silently getting a worse answer.
        this.#append('state', `could not attach the page image: ${String(err)}`);
      }
    }
    // Gate G14 measures time to FIRST ANYTHING on screen, so a state line goes up
    // immediately — adaptive thinking puts first content many seconds out by design.
    const status = this.#append('state', 'thinking…');
    let answer: HTMLElement | null = null;

    try {
      for await (const ev of ask({
        token: this.token,
        question,
        blockIds,
        selectionText: crop?.text ?? '',
        cropPng: crop?.png,
        signal: this.#abort.signal,
      })) {
        this.#render(ev, status, () => {
          answer ??= this.#append('ai', '');
          return answer;
        });
      }
    } catch (err) {
      // I5: never swallowed, and it says the document is untouched — which is the fact
      // the user actually needs when a request fails mid-flight.
      status.textContent = `The request failed: ${String(err)}. Your document is unchanged.`;
      status.className = 'chat-line chat-line--problem';
    } finally {
      this.#busy = false;
      if (status.textContent === 'thinking…') status.remove();
    }
  }

  #render(ev: ChatEvent, status: HTMLElement, answerLine: () => HTMLElement): void {
    switch (ev.kind) {
      case 'state':
      case 'thinking':
        status.textContent = ev.kind === 'thinking' ? 'thinking…' : ev.text;
        break;
      case 'text':
        status.remove();
        answerLine().textContent += ev.text;
        break;
      case 'problem':
        status.textContent = ev.text;
        status.className = 'chat-line chat-line--problem';
        break;
      case 'done':
        status.remove();
        break;
    }
  }
}
