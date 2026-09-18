/**
 * Undo. Acceptance row 19: every AI edit and every user edit is exactly one step.
 *
 * The history holds INVERSE OP LISTS, not document snapshots. A snapshot undo replays
 * a whole document and so silently discards anything that changed concurrently — the
 * file watcher reloading an edited source file, or an AI edit landing mid-session.
 */

import { describe, expect, it } from 'vitest';
import { KernelActions, nextSeed } from '../../web/src/app/actions';
import type { Delta, Document, Problem } from '../../web/src/types/document';

function doc(): Document {
  return {
    schema_version: 1,
    id: 'd',
    title: 't',
    blocks: [
      { kind: 'prose', id: 'b1', seed: 11, text: 'first' },
      { kind: 'prose', id: 'b2', seed: 22, text: 'second' },
    ],
  };
}

function harness() {
  const sent: Delta[] = [];
  const problems: Problem[] = [];
  let version = 0;
  const actions = new KernelActions({
    selection: { blockIds: [], set: () => {}, clear: () => {}, onChange: () => {} },
    problems: {
      raise: (p) => problems.push(p),
      clearBlock: () => {},
      all: problems,
      onChange: () => {},
    },
    protocol: {
      name: 'fake',
      connect: async () => {},
      snapshot: async () => ({ version, document: doc() }),
      sendDelta: async (d) => {
        sent.push(d);
        version += 1;
      },
      onRemoteDelta: () => {},
      onDisconnect: () => {},
      connected: true,
    },
    currentDoc: () => doc(),
    currentVersion: () => version,
    resync: async () => {},
  });
  return { actions, sent, problems };
}

describe('editor actions', () => {
  it('an edit is one undo step, and undo sends the inverse', async () => {
    const { actions, sent } = harness();
    expect(actions.canUndo).toBe(false);

    await actions.editBlock('b1', 'edited');
    expect(actions.canUndo).toBe(true);
    expect(sent).toHaveLength(1);

    await actions.undo();
    expect(sent).toHaveLength(2);
    const inverse = sent[1]!.ops[0]!;
    expect(inverse.op).toBe('replace');
    // The inverse restores the ORIGINAL text, taken while it was still in hand.
    expect((inverse as { block: { text: string } }).block.text).toBe('first');
    expect(actions.canUndo).toBe(false);
    expect(actions.canRedo).toBe(true);
  });

  it('redo replays the forward ops', async () => {
    const { actions, sent } = harness();
    await actions.editBlock('b1', 'edited');
    await actions.undo();
    await actions.redo();
    const forward = sent[2]!.ops[0]!;
    expect((forward as { block: { text: string } }).block.text).toBe('edited');
  });

  it('a new edit clears the redo branch', async () => {
    const { actions } = harness();
    await actions.editBlock('b1', 'one');
    await actions.undo();
    expect(actions.canRedo).toBe(true);
    await actions.editBlock('b2', 'two');
    // Keeping it would let redo replay an op against a document it was never computed for.
    expect(actions.canRedo).toBe(false);
  });

  it('re-roll changes seeds and nothing else', async () => {
    const { actions, sent } = harness();
    await actions.reroll(['b1'], 'block');
    const op = sent[0]!.ops[0]! as { block: { seed: number; text: string } };
    expect(op.block.seed).not.toBe(11);
    expect(op.block.text).toBe('first');
  });

  it('re-roll at document scale takes every block', async () => {
    const { actions, sent } = harness();
    await actions.reroll([], 'document');
    expect(sent[0]!.ops).toHaveLength(2);
  });

  it('the next seed is deterministic, never random', () => {
    // A Math.random() here would make the page unreproducible forever after, which is
    // the one thing the seeded architecture exists to prevent.
    expect(nextSeed(11)).toBe(nextSeed(11));
    expect(nextSeed(11)).not.toBe(nextSeed(12));
  });

  it('editing an unknown block raises a named problem rather than failing silently', async () => {
    const { actions, problems } = harness();
    await actions.editBlock('nope', 'x');
    expect(problems.map((p) => p.code)).toContain('edit.unknown-block');
  });

  it('a rejected delta is NOT pushed onto the history, and says so', async () => {
    // If a failed edit left a history entry, the next undo would send an inverse for a
    // change the server never applied — corrupting the document to "fix" it.
    const problems: Problem[] = [];
    const actions = new KernelActions({
      selection: { blockIds: [], set: () => {}, clear: () => {}, onChange: () => {} },
      problems: {
        raise: (p) => problems.push(p),
        clearBlock: () => {},
        all: problems,
        onChange: () => {},
      },
      protocol: {
        name: 'rejecting',
        connect: async () => {},
        snapshot: async () => ({ version: 5, document: doc() }),
        sendDelta: async () => {
          throw new Error('409 parent mismatch');
        },
        onRemoteDelta: () => {},
        onDisconnect: () => {},
        connected: true,
      },
      currentDoc: () => doc(),
      currentVersion: () => 0,
      resync: async () => {},
    });

    await actions.editBlock('b1', 'edited');
    expect(actions.canUndo).toBe(false);
    expect(problems.map((p) => p.code)).toContain('edit.rejected');
  });
});
