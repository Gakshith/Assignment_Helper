/**
 * The glyph studio. Acceptance rows 4, 5 and 9.
 *
 * Row 9 is the one that shapes it: on first launch, with no profile, the app opens
 * HERE rather than on an error, and offers three ways forward — print the tracing
 * sheet, or carry on with the reference hand, or (once a sheet exists) upload the
 * photos. A page must be renderable within 60 s of first launch with zero setup, so
 * "carry on with the reference hand" is always available and always labelled as not
 * being the user's handwriting.
 *
 * Row 4 is the failure side: a sheet that could not be read lists the cells that
 * failed, by name, and never writes a half-built profile that looks complete.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — live glyph capture, row 5's "draw this one
 * now". Drawing produces a STROKE, and turning a stroke into a fillable outline is
 * variable-width stroke geometry, which is M5's work (perfect-freehand, pressure, the
 * ink stack). A constant-width ribbon built here would be a second, inferior outline
 * pipeline that M5 would immediately replace, and glyphs made with it would look
 * different from every traced glyph beside them. The studio says so where the button
 * would be, rather than shipping a worse version of a thing the plan already sequences.
 */

import type { EditorActions } from '../../app/contracts';

export interface ProfileSummary {
  readonly profileId: string;
  readonly status: 'complete' | 'incomplete';
  readonly coverage: {
    readonly covered: number;
    readonly requested: number;
    readonly ratio: number;
    readonly missing: readonly string[];
  };
  readonly failedCells?: readonly { readonly ch: string; readonly reason: string }[];
}

export interface StudioDeps {
  readonly actions: EditorActions;
  /** Current hand id from the document's style. */
  currentProfile(): string;
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

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

export class GlyphStudio {
  #body: HTMLElement | null = null;

  constructor(private readonly deps: StudioDeps) {}

  mount(host: HTMLElement): void {
    host.replaceChildren();
    host.classList.add('studio');

    const head = el('div', 'studio-head');
    head.append(el('h2', 'studio-title', 'Your handwriting'));
    host.append(head);

    this.#body = el('div', 'studio-body');
    host.append(this.#body);

    void this.refresh();
  }

  async refresh(): Promise<void> {
    const body = this.#body;
    if (!body) return;
    body.replaceChildren();

    let profiles: string[] = [];
    try {
      const res = await this.deps.request<{ profiles: string[] }>('/api/glyphs/profiles');
      profiles = res.profiles ?? [];
    } catch (err) {
      // Not swallowed: the studio failing to list is different from there being none,
      // and the two need different actions from the user.
      body.append(
        el('p', 'studio-problem', `Could not list profiles: ${String(err)}`),
      );
      return;
    }

    const current = this.deps.currentProfile();
    body.append(this.#renderCurrent(current, profiles));

    if (profiles.length === 0) {
      // Acceptance row 9: no profile is not an error state. It is the first-run state.
      body.append(this.#renderFirstRun());
      return;
    }

    for (const id of profiles) {
      body.append(await this.#renderProfile(id, current));
    }
    body.append(this.#renderSheetSection());
  }

  #renderCurrent(current: string, profiles: readonly string[]): HTMLElement {
    const box = el('section', 'studio-section');
    box.append(el('h3', 'studio-h3', 'In use now'));
    const isReference = !profiles.includes(current);
    box.append(
      el(
        'p',
        isReference ? 'studio-note studio-note--warn' : 'studio-note',
        isReference
          ? `${current} — the bundled reference hand. This is NOT your handwriting.`
          : `${current} — your own hand.`,
      ),
    );
    return box;
  }

  #renderFirstRun(): HTMLElement {
    const box = el('section', 'studio-section');
    box.append(el('h3', 'studio-h3', 'You have not made a hand yet'));
    box.append(
      el(
        'p',
        'studio-note',
        'Nothing is broken. Pages render right now in the reference hand, and you can ' +
          'swap to your own whenever you have filled in a tracing sheet.',
      ),
    );
    box.append(this.#sheetButton());
    return box;
  }

  #renderSheetSection(): HTMLElement {
    const box = el('section', 'studio-section');
    box.append(el('h3', 'studio-h3', 'Make another hand'));
    box.append(this.#sheetButton());
    box.append(
      el(
        'p',
        'studio-note studio-note--quiet',
        'Drawing a glyph directly is not built. A drawn stroke has to become a filled ' +
          'outline, which is variable-width stroke geometry — that lands with the ' +
          'pressure and ink work, and a constant-width stand-in would look wrong beside ' +
          'every traced glyph on the same page.',
      ),
    );
    return box;
  }

  #sheetButton(): HTMLElement {
    const row = el('div', 'studio-row');
    const btn = el('button', 'bar-button', 'Print a tracing sheet');
    btn.id = 'studio-sheet';
    btn.setAttribute('type', 'button');
    const status = el('span', 'studio-note studio-note--quiet');
    btn.addEventListener('click', () => {
      status.textContent = 'generating…';
      void this.deps
        .request<{
          path: string;
          pages: number;
          cellsPerPage: number;
          colourDropVerifiedOnPaper: boolean;
        }>('/api/glyphs/sheet', {
          method: 'POST',
          // Beside the document, where the exported PDF goes too — the user should not
          // have to hunt through Application Support for something they must print.
          body: JSON.stringify({ destination: 'tracing-sheet.pdf' }),
        })
        .then((res) => {
          status.textContent =
            `${res.pages} sheets, ${res.cellsPerPage} cells each → ${res.path}` +
            (res.colourDropVerifiedOnPaper
              ? ''
              : ' · the non-photo-blue grid drop is UNVERIFIED on real paper — if extraction goes badly, that is the first thing to suspect');
        })
        .catch((err) => {
          status.textContent = `could not generate the sheet: ${String(err)}`;
          status.className = 'studio-problem';
        });
    });
    row.append(btn, status);
    return row;
  }

  async #renderProfile(id: string, current: string): Promise<HTMLElement> {
    const box = el('section', 'studio-section');
    box.append(el('h3', 'studio-h3', id));

    let summary: ProfileSummary;
    try {
      summary = await this.deps.request<ProfileSummary>(
        `/api/glyphs/profile/${encodeURIComponent(id)}`,
      );
    } catch (err) {
      box.append(el('p', 'studio-problem', `Could not read this profile: ${String(err)}`));
      return box;
    }

    const pct = Math.round(summary.coverage.ratio * 100);
    box.append(
      el(
        'p',
        summary.status === 'complete' ? 'studio-note' : 'studio-note studio-note--warn',
        `${summary.status} — ${summary.coverage.covered}/${summary.coverage.requested} characters (${pct}%)`,
      ),
    );

    // Row 4: name the cells that failed. A count alone tells the user nothing about
    // whether to re-shoot the sheet or just accept the gap.
    if (summary.coverage.missing.length > 0) {
      const missing = el('p', 'studio-missing');
      missing.append(document.createTextNode('Missing: '));
      for (const ch of summary.coverage.missing) {
        missing.append(el('code', 'studio-char', ch));
      }
      box.append(missing);
    }

    if (id !== current) {
      const use = el('button', 'bar-button', 'Write in this hand');
      use.setAttribute('type', 'button');
      use.addEventListener('click', () => void this.#useProfile(id));
      box.append(use);
    }
    return box;
  }

  async #useProfile(id: string): Promise<void> {
    const doc = this.deps.actions;
    // Goes through setStyle so it is one delta, one undo step, and the server stays
    // authoritative — switching hands is an edit like any other.
    const snapshot = await this.deps.request<{ document: { style: unknown } }>(
      '/api/document/snapshot',
    );
    const style = snapshot.document.style as { hand: Record<string, unknown> };
    await doc.setStyle({ ...style, hand: { ...style.hand, profile: id } } as never);
    await this.refresh();
  }
}
