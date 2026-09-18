// OWNER: the glyph-studio strand.
import { GlyphStudio, type StudioDeps } from './studio';

/** Session token from sessionStorage, where the frozen main.ts put it (I16). */
function token(): string | null {
  try {
    return sessionStorage.getItem('ah.token');
  } catch {
    return null;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = token();
  if (t) headers['x-ah-token'] = t;
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${path} failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function createGlyphStudio(deps: Omit<StudioDeps, 'request'>): GlyphStudio {
  return new GlyphStudio({ ...deps, request });
}

export { GlyphStudio } from './studio';
