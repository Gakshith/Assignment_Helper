/**
 * Fetching the hand, once, loudly.
 *
 * Invariant I5 runs through this whole file. Every failure mode here — the font is not
 * served, the server returns an HTML 404 page with a 200, the bytes are not a font, the
 * document asks for a hand that does not exist — has an obvious "just fall back to the
 * reference hand" escape, and every one of those escapes produces a page that looks
 * plausible and is wrong. A page rendered in the wrong hand is not a smaller failure than
 * no page; it is a worse one, because nobody checks it.
 */

import type { GlyphProfileProvider } from '../../app/contracts';
import { parseHand, type ParsedHand } from './font';
import { buildHand, type Hand } from './provider';
import { REFERENCE_HAND, isReferenceProfile } from './reference';

/** Injected in tests. The default reads the bundled font over HTTP. */
export type FontFetcher = (path: string) => Promise<ArrayBuffer>;

/**
 * Resolve the font path against the document base rather than the origin root.
 *
 * `/fonts/...` would break the moment the app is served under a sub-path, and the
 * symptom would be a 404 during boot on someone else's machine only.
 */
function defaultBaseUrl(): string {
  if (typeof document !== 'undefined' && document.baseURI) return document.baseURI;
  if (typeof location !== 'undefined') return location.href;
  throw new Error('no document base to resolve the reference font against');
}

export async function fetchFont(path: string): Promise<ArrayBuffer> {
  const url = new URL(path, defaultBaseUrl()).toString();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`could not fetch the reference hand from ${url}: HTTP ${res.status}`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) {
    throw new Error(`the reference hand at ${url} is empty`);
  }
  return buf;
}

export interface GlyphProviderOptions {
  readonly fetchFont?: FontFetcher;
}

/**
 * The registered `GlyphProfileProvider`.
 *
 * `load()` memoises per profile id INCLUDING failures-in-flight, so the kernel calling it
 * twice (a style change that renames the hand, then changes back) parses the font once.
 * A rejected promise is dropped from the map so a transient network failure can be
 * retried rather than being cached forever.
 */
export function createGlyphProfileProvider(
  options: GlyphProviderOptions = {},
): GlyphProfileProvider {
  const fetcher = options.fetchFont ?? fetchFont;
  const inFlight = new Map<string, Promise<Hand>>();

  const loadReference = async (): Promise<Hand> => {
    const bytes = await fetcher(REFERENCE_HAND.fontPath);
    let parsed: ParsedHand;
    try {
      parsed = parseHand(bytes);
    } catch (err) {
      // Re-thrown with the path, because "Unsupported OpenType signature" on its own
      // sends whoever reads the console looking in the wrong place. The usual cause is a
      // dev server answering a missing-file request with index.html and a 200.
      throw new Error(
        `the reference hand at ${REFERENCE_HAND.fontPath} could not be parsed ` +
          `(${bytes.byteLength} bytes): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return buildHand(REFERENCE_HAND.profileId, parsed);
  };

  return {
    name: 'opentype-glyphs',

    async load(profileId: string): Promise<Hand> {
      if (!isReferenceProfile(profileId)) {
        // Not a fallback. A document that names a personal hand and silently gets the
        // reference one would be submitted in the wrong handwriting.
        throw new Error(
          `no glyph profile named "${profileId}" is available. Only the bundled ` +
            `reference hand (${REFERENCE_HAND.family}) exists in this build; extracted ` +
            `personal profiles arrive with the glyph-extraction strand.`,
        );
      }

      const existing = inFlight.get(profileId);
      if (existing !== undefined) return existing;

      const pending = loadReference();
      inFlight.set(profileId, pending);
      pending.catch(() => inFlight.delete(profileId));
      return pending;
    },
  };
}
