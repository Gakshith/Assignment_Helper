import { describe, expect, it } from 'vitest';
import { SseDecoder } from '../../web/src/ui/chat/transport';

const frame = (o: object) => `data: ${JSON.stringify(o)}\n\n`;

describe('SSE decoding', () => {
  it('decodes whole frames', () => {
    const d = new SseDecoder();
    const out = d.push(frame({ kind: 'text', text: 'hello' }) + frame({ kind: 'done' }));
    expect(out.map((e) => e.kind)).toEqual(['text', 'done']);
    expect(out[0]!.text).toBe('hello');
  });

  it('reassembles a frame split across chunks', () => {
    // The bug this prevents works fine on localhost with short answers and shreds the
    // first long one a user asks for.
    const d = new SseDecoder();
    const whole = frame({ kind: 'text', text: 'a long answer' });
    const cut = Math.floor(whole.length / 2);
    expect(d.push(whole.slice(0, cut))).toEqual([]);
    const out = d.push(whole.slice(cut));
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('a long answer');
  });

  it('handles many frames arriving in one chunk', () => {
    const d = new SseDecoder();
    const chunk = [1, 2, 3, 4].map((i) => frame({ kind: 'text', text: `t${i}` })).join('');
    expect(d.push(chunk).map((e) => e.text)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('surfaces a malformed frame instead of dropping it', () => {
    // Silently dropping it would present a truncated answer as a complete one (I5).
    const d = new SseDecoder();
    const out = d.push('data: {not json}\n\n');
    expect(out[0]!.kind).toBe('problem');
    expect(out[0]!.code).toBe('chat.bad-frame');
  });

  it('reports a stream that ends mid-frame', () => {
    const d = new SseDecoder();
    d.push('data: {"kind":"text","text":"half');
    const out = d.finish();
    expect(out[0]!.kind).toBe('problem');
    expect(out[0]!.code).toBe('chat.truncated');
    expect(out[0]!.text).toContain('nothing was applied');
  });

  it('a clean end leaves nothing behind', () => {
    const d = new SseDecoder();
    d.push(frame({ kind: 'done' }));
    expect(d.finish()).toEqual([]);
  });

  it('carries a problem code through from the server', () => {
    const d = new SseDecoder();
    const out = d.push(frame({ kind: 'problem', code: 'llm.rate-limited', text: 'slow down' }));
    expect(out[0]!.code).toBe('llm.rate-limited');
  });
});
