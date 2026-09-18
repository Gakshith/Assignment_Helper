/**
 * The style write path. Invariant I4: the SERVER document is authoritative.
 *
 * The panel never mutates a document locally and hopes. It posts a complete Style to
 * `/api/document/style`, which the router turns into a one-op delta at the current
 * version, and the snapshot that comes back is what the panel believes afterwards.
 *
 * THE TWO CLOCKS. The dial runs at 60fps and this runs at 100 ms. Every drag frame
 * calls `commit()`; `commit()` only remembers the latest style and re-arms a timer,
 * so a 600 ms drag is one or two POSTs rather than forty. The thumb is never waiting
 * on this -- that is the whole point of separating them.
 *
 * Invariant I5: nothing here falls back. A rejected write rejects, the caller is
 * told, and the panel says so on screen. There is no retry that could silently
 * resurrect a stale style on top of a newer one.
 */

import type { Snapshot, Style } from '../../types/document';
import { api, ApiError } from '../shell/session';
import { resolveStyle, toWire, type ResolvedStyle } from './style-model';

/** Inside the 80-120 ms the design fixes for the render side. */
export const COMMIT_DEBOUNCE_MS = 100;

export interface StyleTransport {
  snapshot(): Promise<Snapshot>;
  postStyle(style: Style): Promise<Snapshot>;
}

export const httpTransport: StyleTransport = {
  snapshot: () => api<Snapshot>('/api/document/snapshot'),
  postStyle: (style) =>
    api<Snapshot>('/api/document/style', { method: 'POST', body: JSON.stringify(style) }),
};

export interface LoadedDocument {
  readonly title: string;
  readonly version: number;
  readonly style: ResolvedStyle;
}

function adopt(snapshot: Snapshot): LoadedDocument {
  return {
    title: snapshot.document.title ?? '',
    version: snapshot.version,
    style: resolveStyle(snapshot.document.style),
  };
}

export class StyleClient {
  #queued: ResolvedStyle | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #inFlight = false;
  #adopted: ((doc: LoadedDocument) => void)[] = [];
  #failed: ((err: ApiError) => void)[] = [];

  constructor(
    private readonly transport: StyleTransport = httpTransport,
    private readonly debounceMs: number = COMMIT_DEBOUNCE_MS,
  ) {}

  onAdopted(handler: (doc: LoadedDocument) => void): void {
    this.#adopted.push(handler);
  }

  /** Every failed call lands here. There is no other exit. */
  onFailed(handler: (err: ApiError) => void): void {
    this.#failed.push(handler);
  }

  async load(): Promise<void> {
    try {
      this.#announce(adopt(await this.transport.snapshot()));
    } catch (err) {
      this.#report(err);
    }
  }

  /** Called from the drag loop. Cheap, synchronous, and never awaited by the caller. */
  commit(next: ResolvedStyle): void {
    this.#queued = next;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#flush();
    }, this.debounceMs);
  }

  /** Tests and teardown: send whatever is queued right now. */
  async flushNow(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#inFlight) return; // the in-flight call re-checks the queue when it lands
    const next = this.#queued;
    if (next === null) return;
    this.#queued = null;
    this.#inFlight = true;
    try {
      this.#announce(adopt(await this.transport.postStyle(toWire(next))));
    } catch (err) {
      this.#report(err);
    } finally {
      this.#inFlight = false;
    }
    // A newer style arrived while that was on the wire. Send the latest, and only
    // the latest: replaying the intermediate ones would write a stale style last.
    if (this.#queued !== null) await this.#flush();
  }

  #announce(doc: LoadedDocument): void {
    for (const handler of this.#adopted) handler(doc);
  }

  #report(err: unknown): void {
    // An error that is not an ApiError is a fault in this build, not in the server,
    // and it is rethrown rather than folded into the same channel.
    if (!(err instanceof ApiError)) throw err;
    for (const handler of this.#failed) handler(err);
  }
}
