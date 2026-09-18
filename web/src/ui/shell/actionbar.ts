/**
 * The top bar's verbs: Solve, Export, Undo, Redo, Re-roll.
 *
 * Solve is the product's headline and for a long time it had no button — the endpoint
 * worked, was tested, and nothing called it, which made this a markdown-to-handwriting
 * renderer rather than an assignment helper.
 *
 * Every button reflects real state: disabled while solving, disabled when there is
 * nothing to undo, disabled when export is refused. A button that looks available and
 * then fails is worse than one that is honestly greyed out.
 */

import type { EditorActions, RerollScale } from '../../app/contracts';

export interface ActionBarHost {
  readonly actions: EditorActions;
  /** Produces a PDF. Returns null when refused; the kernel has already raised why. */
  exportPdf(): Promise<{ path: string } | null>;
  canExport(): boolean;
  status(message: string, kind?: 'info' | 'warn'): void;
}

function button(id: string, label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.id = id;
  b.className = 'bar-button';
  b.textContent = label;
  b.title = title;
  return b;
}

export function mountActionBar(host: HTMLElement, deps: ActionBarHost): void {
  const { actions } = deps;

  const solve = button('act-solve', 'Solve', 'Work the problems in this document and write the solutions');
  const exportBtn = button('act-export', 'Export PDF', 'Render every page and save a PDF beside the document');
  const undo = button('act-undo', 'Undo', 'Undo the last change (⌘Z)');
  const redo = button('act-redo', 'Redo', 'Redo (⇧⌘Z)');

  const reroll = document.createElement('select');
  reroll.id = 'act-reroll';
  reroll.className = 'bar-select';
  reroll.title = 'Re-write in a differently imperfect hand';
  for (const [value, label] of [
    ['', 'Re-roll…'],
    ['block', 'selected blocks'],
    ['page', 'this run'],
    ['document', 'whole document'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    reroll.append(opt);
  }

  const status = document.createElement('span');
  status.className = 'bar-status';
  status.id = 'act-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const group = document.createElement('div');
  group.className = 'bar-actions';
  group.append(solve, exportBtn, undo, redo, reroll, status);
  host.append(group);

  const say = (message: string, kind: 'info' | 'warn' = 'info') => {
    status.textContent = message;
    status.dataset['kind'] = kind;
    deps.status(message, kind);
  };

  const sync = () => {
    undo.disabled = !actions.canUndo || actions.solving;
    redo.disabled = !actions.canRedo || actions.solving;
    solve.disabled = actions.solving;
    exportBtn.disabled = actions.solving || !deps.canExport();
    exportBtn.title = deps.canExport()
      ? 'Render every page and save a PDF beside the document'
      : 'Export is blocked while a block carries a problem badge — fix it first';
    reroll.disabled = actions.solving;
  };

  actions.onHistoryChange(sync);
  actions.onSolveStateChange(sync);
  actions.selection.onChange(sync);

  solve.addEventListener('click', () => {
    say('solving…');
    void actions.solve().then((outcome) => {
      // §C.5.2: when the model was not confident the page must NOT be presented as
      // finished. The warning names the problems so the student knows where to look.
      say(outcome.message, outcome.reviewRequired || !outcome.applied ? 'warn' : 'info');
      sync();
    });
  });

  exportBtn.addEventListener('click', () => {
    say('exporting…');
    void deps.exportPdf().then((res) => {
      say(res ? `saved ${res.path}` : 'export was refused — see the banner', res ? 'info' : 'warn');
      sync();
    });
  });

  undo.addEventListener('click', () => void actions.undo().then(sync));
  redo.addEventListener('click', () => void actions.redo().then(sync));

  reroll.addEventListener('change', () => {
    const scale = reroll.value as RerollScale | '';
    reroll.value = '';
    if (!scale) return;
    const ids = actions.selection.blockIds;
    if (scale === 'block' && ids.length === 0) {
      say('select something first, or re-roll the whole document', 'warn');
      return;
    }
    void actions.reroll(ids, scale).then(() => {
      say(scale === 'document' ? 're-rolled the document' : `re-rolled ${scale}`);
      sync();
    });
  });

  sync();
}
