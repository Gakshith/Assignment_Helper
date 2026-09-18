/**
 * The chat transport: an SSE stream from the local server, decoded into typed events.
 *
 * Pure enough to test in node — the parser takes text chunks and yields events, so the
 * behaviour that actually breaks (a frame split across two network chunks) is testable
 * without a browser or a server.
 */

export type ChatEventKind = 'thinking' | 'text' | 'state' | 'problem' | 'done';

export interface ChatEvent {
  readonly kind: ChatEventKind;
  readonly text: string;
  readonly code?: string;
}

/**
 * Incremental SSE frame parser.
 *
 * A stream does not arrive in whole frames. Treating each network chunk as a frame is
 * the classic bug here: it works on localhost with short messages and shreds the first
 * long answer a user asks for.
 */
export class SseDecoder {
  #buffer = '';

  push(chunk: string): ChatEvent[] {
    this.#buffer += chunk;
    const events: ChatEvent[] = [];
    let idx: number;
    while ((idx = this.#buffer.indexOf('\n\n')) !== -1) {
      const frame = this.#buffer.slice(0, idx);
      this.#buffer = this.#buffer.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        const parsed = JSON.parse(json) as { kind: ChatEventKind; text?: string; code?: string };
        events.push({
          kind: parsed.kind,
          text: parsed.text ?? '',
          ...(parsed.code ? { code: parsed.code } : {}),
        });
      } catch (err) {
        // NOT swallowed. A malformed frame means the server and client disagree about
        // the wire format, and silently dropping it would present a truncated answer
        // as a complete one (invariant I5).
        events.push({
          kind: 'problem',
          code: 'chat.bad-frame',
          text: `The server sent a frame this client could not read: ${String(err)}`,
        });
      }
    }
    return events;
  }

  /** Anything left when the stream ends is an incomplete frame, which is a problem. */
  finish(): ChatEvent[] {
    if (!this.#buffer.trim()) return [];
    const leftover = this.#buffer;
    this.#buffer = '';
    return [
      {
        kind: 'problem',
        code: 'chat.truncated',
        text: `The stream ended mid-frame. The answer is incomplete and nothing was applied. Leftover: ${leftover.slice(0, 120)}`,
      },
    ];
  }
}

export interface AskOptions {
  readonly token: string | null;
  readonly question: string;
  readonly blockIds: readonly string[];
  readonly selectionText: string;
  readonly signal?: AbortSignal;
}

export async function* ask(opts: AskOptions): AsyncGenerator<ChatEvent> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers['x-ah-token'] = opts.token;

  const response = await fetch('/api/chat/ask', {
    method: 'POST',
    headers,
    ...(opts.signal ? { signal: opts.signal } : {}),
    body: JSON.stringify({
      payload: {
        question: opts.question,
        selection: opts.blockIds.length
          ? { block_ids: [...opts.blockIds], text: opts.selectionText, page_index: 0 }
          : null,
        document_text: '',
        image_crop_png: null,
      },
    }),
  });

  if (!response.ok || !response.body) {
    const detail = await response.text();
    yield {
      kind: 'problem',
      code: 'chat.http',
      text: `The local server refused the request (${response.status}). ${detail.slice(0, 200)}`,
    };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of sse.push(decoder.decode(value, { stream: true }))) yield ev;
  }
  for (const ev of sse.finish()) yield ev;
}
