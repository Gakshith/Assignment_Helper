/**
 * The editor's verbs, and the undo history behind them.
 *
 * Every verb here produces a DELTA that goes to the server (invariant I4: the server
 * document is authoritative). Nothing mutates the local document and hopes the server
 * agrees later.
 *
 * ## Undo
 *
 * Acceptance row 19: every AI edit and every user edit is exactly one undo step. The
 * stack holds INVERSE OP LISTS, computed at the moment the forward delta is built,
 * while the old block is still in hand:
 *
 *   insert(i, b)          -> remove(b.id)
 *   remove(id)            -> insert(originalIndex, oldBlock)
 *   replace(id, newBlock) -> replace(id, oldBlock)
 *   style(s)              -> style(oldStyle)
 *
 * Deliberately NOT a stack of document snapshots. A snapshot undo silently discards a
 * concurrent change from another source — the file watcher reloading an edited file,
 * or the AI applying an edit — because it replays a whole document rather than the one
 * change the user asked to take back.
 */

import type {
  Block,
  Delta,
  Document,
  EditorActions,
  Op,
  ProblemSink,
  ProtocolClient,
  RerollScale,
  SelectionModel,
  Style,
} from './contracts';

/** Bounded: an unbounded history on a long editing session is a memory leak. */
const MAX_HISTORY = 100;

interface HistoryEntry {
  readonly forward: readonly Op[];
  readonly inverse: readonly Op[];
  readonly label: string;
}

export interface ActionsDeps {
  readonly selection: SelectionModel;
  readonly problems: ProblemSink;
  readonly protocol: ProtocolClient;
  currentDoc(): Document | null;
  currentVersion(): number;
  /** Ask the kernel to resync after a rejected delta. */
  resync(): Promise<void>;
}

export class KernelActions implements EditorActions {
  #undo: HistoryEntry[] = [];
  #redo: HistoryEntry[] = [];
  #historyHandlers: (() => void)[] = [];
  #askHandlers: ((blockIds: readonly string[]) => void)[] = [];

  constructor(private readonly deps: ActionsDeps) {}

  get selection(): SelectionModel {
    return this.deps.selection;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  onHistoryChange(handler: () => void): void {
    this.#historyHandlers.push(handler);
  }

  requestAsk(blockIds: readonly string[]): void {
    for (const h of this.#askHandlers) h(blockIds);
  }

  onAskRequested(handler: (blockIds: readonly string[]) => void): void {
    this.#askHandlers.push(handler);
  }

  // ------------------------------------------------------------------ verbs

  async reroll(blockIds: readonly string[], scale: RerollScale): Promise<void> {
    const doc = this.deps.currentDoc();
    if (!doc) return;

    const targets = this.#targetsFor(doc, blockIds, scale);
    if (targets.length === 0) return;

    const ops: Op[] = [];
    const inverse: Op[] = [];
    for (const block of targets) {
      // A new seed is the whole re-roll: same words, different imperfection. The seed
      // is derived from the old one so a re-roll is reproducible from the document
      // alone — a Math.random() here would make the page unreproducible forever after,
      // which is the one thing the seeded architecture exists to prevent.
      const next = nextSeed(block.seed);
      ops.push({ op: 'replace', block_id: block.id, block: { ...block, seed: next } as Block });
      inverse.push({ op: 'replace', block_id: block.id, block });
    }
    await this.#send(ops, inverse, `re-roll ${targets.length} block(s)`);
  }

  async editBlock(blockId: string, text: string): Promise<void> {
    const doc = this.deps.currentDoc();
    const block = doc?.blocks?.find((b) => b.id === blockId);
    if (!block) {
      this.deps.problems.raise({
        scope: 'app',
        code: 'edit.unknown-block',
        message: `Cannot edit ${blockId}: no such block in the current document.`,
      });
      return;
    }
    let next: Block;
    if (block.kind === 'prose') next = { ...block, text };
    else if (block.kind === 'math') next = { ...block, latex: text };
    else {
      this.deps.problems.raise({
        scope: 'block',
        code: 'edit.unsupported-kind',
        message: `A ${block.kind} block is not text-editable.`,
        block_id: blockId,
      });
      return;
    }
    await this.#send(
      [{ op: 'replace', block_id: blockId, block: next }],
      [{ op: 'replace', block_id: blockId, block }],
      'edit block',
    );
  }

  async setStyle(style: Style): Promise<void> {
    const doc = this.deps.currentDoc();
    if (!doc?.style) return;
    await this.#send([{ op: 'style', style }], [{ op: 'style', style: doc.style }], 'restyle');
  }

  async undo(): Promise<void> {
    const entry = this.#undo.pop();
    if (!entry) return;
    const ok = await this.#post(entry.inverse);
    if (!ok) {
      this.#undo.push(entry);
      return;
    }
    this.#redo.push(entry);
    this.#emitHistory();
  }

  async redo(): Promise<void> {
    const entry = this.#redo.pop();
    if (!entry) return;
    const ok = await this.#post(entry.forward);
    if (!ok) {
      this.#redo.push(entry);
      return;
    }
    this.#undo.push(entry);
    this.#emitHistory();
  }

  // ------------------------------------------------------------------ internals

  #targetsFor(doc: Document, blockIds: readonly string[], scale: RerollScale): Block[] {
    const blocks = doc.blocks ?? [];
    if (scale === 'document') return [...blocks];
    if (scale === 'block') return blocks.filter((b) => blockIds.includes(b.id));
    // 'page': everything from the first selected block to the end of its page is not
    // knowable from the document alone — pagination lives in geometry. The honest
    // approximation is the contiguous run around the selection, and it is documented
    // as such rather than silently meaning something else.
    const first = blocks.findIndex((b) => blockIds.includes(b.id));
    if (first < 0) return [];
    const last = blocks.map((b) => blockIds.includes(b.id)).lastIndexOf(true);
    return blocks.slice(first, Math.max(first + 1, last + 1));
  }

  async #send(forward: readonly Op[], inverse: readonly Op[], label: string): Promise<void> {
    const ok = await this.#post(forward);
    if (!ok) return;
    this.#undo.push({ forward, inverse, label });
    if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
    // A new edit invalidates the redo branch. Keeping it would let redo replay an op
    // against a document it was never computed for.
    this.#redo = [];
    this.#emitHistory();
  }

  async #post(ops: readonly Op[]): Promise<boolean> {
    const delta: Delta = {
      parent_version: this.deps.currentVersion(),
      ops: [...ops],
      origin: 'user',
    };
    try {
      await this.deps.protocol.sendDelta(delta);
      return true;
    } catch (err) {
      // I5: never swallowed. A rejected delta means the client is behind, so resync
      // rather than retrying blind — I4 forbids reconciling heuristically.
      this.deps.problems.raise({
        scope: 'app',
        code: 'edit.rejected',
        message: 'That change was not applied; resyncing with the server.',
        detail: String(err),
      });
      await this.deps.resync();
      return false;
    }
  }

  #emitHistory(): void {
    for (const h of this.#historyHandlers) h();
  }
}

/**
 * The next seed in a re-roll chain. Deterministic, so a re-rolled page is still
 * reproducible from the document alone.
 */
export function nextSeed(seed: number): number {
  // splitmix64's constant, folded to a safe integer. Any deterministic bijection would
  // do; what matters is that it is NOT random.
  const x = (Math.trunc(seed) ^ 0x9e3779b9) >>> 0;
  let z = (x + 0x6d2b79f5) >>> 0;
  z = Math.imul(z ^ (z >>> 15), z | 1) >>> 0;
  z = (z ^ (z + Math.imul(z ^ (z >>> 7), z | 61))) >>> 0;
  return (z ^ (z >>> 14)) >>> 0;
}
