/**
 * The two clocks. The dial writes every frame; this must not.
 *
 * Also invariant I5: a rejected write is reported, never retried into silence, and
 * never resolved into a style the panel then believes.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Snapshot, Style } from '@/types/document';
import { ApiError } from '@/ui/shell/session';
import { StyleClient, type StyleTransport } from '@/ui/panels/style-client';
import { DEFAULT_STYLE, withHand } from '@/ui/panels/style-model';

function snapshotOf(style: Style, version = 1): Snapshot {
  return { version, document: { id: 'doc-1', title: 'hw7', style } };
}

function recorder(): { transport: StyleTransport; posts: Style[] } {
  const posts: Style[] = [];
  return {
    posts,
    transport: {
      snapshot: async () => snapshotOf({}),
      postStyle: async (style) => {
        posts.push(style);
        return snapshotOf(style, posts.length + 1);
      },
    },
  };
}

describe('StyleClient', () => {
  it('adopts the server snapshot on load, not a local guess', async () => {
    const client = new StyleClient(
      {
        snapshot: async () => snapshotOf({ hand: { neatness: 0.9 } }, 4),
        postStyle: async () => snapshotOf({}),
      },
      0,
    );
    const seen: number[] = [];
    client.onAdopted((doc) => seen.push(doc.style.hand.neatness));
    await client.load();
    expect(seen).toEqual([0.9]);
  });

  it('coalesces a whole drag into one POST carrying the LAST value', async () => {
    const { transport, posts } = recorder();
    const client = new StyleClient(transport, 0);
    for (let frame = 0; frame < 40; frame += 1) {
      client.commit(withHand(DEFAULT_STYLE, { neatness: frame / 40 }));
    }
    expect(posts).toHaveLength(0); // nothing has gone out during the drag
    await client.flushNow();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.hand?.neatness).toBeCloseTo(39 / 40);
  });

  it('debounces rather than fires on every commit', async () => {
    vi.useFakeTimers();
    try {
      const { transport, posts } = recorder();
      const client = new StyleClient(transport, 100);
      client.commit(withHand(DEFAULT_STYLE, { neatness: 0.1 }));
      vi.advanceTimersByTime(60);
      client.commit(withHand(DEFAULT_STYLE, { neatness: 0.2 }));
      expect(posts).toHaveLength(0);
      vi.advanceTimersByTime(60);
      await vi.runAllTimersAsync();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.hand?.neatness).toBe(0.2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the newest style after an in-flight POST, and not the stale one', async () => {
    const posts: Style[] = [];
    let open = (): void => {
      throw new Error('the gate was opened before it was built');
    };
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const client = new StyleClient(
      {
        snapshot: async () => snapshotOf({}),
        postStyle: async (style) => {
          posts.push(style);
          if (posts.length === 1) await gate;
          return snapshotOf(style, posts.length + 1);
        },
      },
      0,
    );

    client.commit(withHand(DEFAULT_STYLE, { neatness: 0.1 }));
    const first = client.flushNow();
    client.commit(withHand(DEFAULT_STYLE, { neatness: 0.2 }));
    client.commit(withHand(DEFAULT_STYLE, { neatness: 0.3 }));
    open();
    await first;

    expect(posts.map((p) => p.hand?.neatness)).toEqual([0.1, 0.3]);
  });

  it('posts a COMPLETE style every time, because the server replaces rather than merges', async () => {
    const { transport, posts } = recorder();
    const client = new StyleClient(transport, 0);
    client.commit(withHand(DEFAULT_STYLE, { ink_colour: '#112233' }));
    await client.flushNow();
    const sent = posts[0];
    expect(sent?.paper?.page_size).toBe('letter');
    expect(sent?.margins_mm).toEqual([25.4, 19.0, 25.4, 31.75]);
    expect(sent?.export_dpi).toBe(200);
  });

  it('reports a rejected write instead of retrying it into silence', async () => {
    const failures: ApiError[] = [];
    const client = new StyleClient(
      {
        snapshot: async () => snapshotOf({}),
        postStyle: async () => {
          throw new ApiError('no document is open', 'document.none-open', 409);
        },
      },
      0,
    );
    client.onFailed((err) => failures.push(err));
    client.commit(DEFAULT_STYLE);
    await client.flushNow();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe('document.none-open');
  });

  it('rethrows a fault that is not an ApiError rather than folding it into the same channel', async () => {
    const client = new StyleClient(
      {
        snapshot: async () => {
          throw new TypeError('a bug in this build');
        },
        postStyle: async () => snapshotOf({}),
      },
      0,
    );
    client.onFailed(() => expect.unreachable('a TypeError is not a server refusal'));
    await expect(client.load()).rejects.toThrow(TypeError);
  });
});
