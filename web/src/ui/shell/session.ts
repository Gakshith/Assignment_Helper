/**
 * The client half of the local session: the token, and one fetch that never lies.
 *
 * Invariant I16: the token arrives once in the launch URL. `main.ts` strips it from
 * the address bar and parks it in sessionStorage; this module reads BOTH sources so
 * it does not depend on which module ran first, and it never logs or persists it
 * anywhere else.
 *
 * Invariant I5: `api()` has no `|| default` and no empty catch. A non-2xx response
 * becomes a typed ApiError carrying the server's own code, which the caller turns
 * into something the user can see. A blank panel is never an acceptable outcome of
 * a failed call.
 */

import { TOKEN_HEADER } from '../../app/protocol';

const TOKEN_KEY = 'ah.token';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The launch URL first, then sessionStorage. Either may legitimately be the source. */
export function sessionToken(): string | null {
  if (typeof location !== 'undefined') {
    const fromUrl = new URL(location.href).searchParams.get('t');
    if (fromUrl) return fromUrl;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch (err) {
    // Not swallowed. Without storage every call after this one is a 403 and the
    // user deserves the real reason rather than a silent empty panel.
    console.error('could not read the session token from sessionStorage', err);
    return null;
  }
}

function describe(status: number, body: unknown): { code: string; message: string; detail: string | null } {
  if (typeof body === 'object' && body !== null && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'object' && detail !== null) {
      const d = detail as Record<string, unknown>;
      const code = typeof d['code'] === 'string' ? d['code'] : `http.${status}`;
      const message =
        typeof d['message'] === 'string' ? d['message'] : `the server refused this call (HTTP ${status})`;
      const rest = Object.entries(d)
        .filter(([k]) => k !== 'code' && k !== 'message')
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      return { code, message, detail: rest.length > 0 ? rest : null };
    }
    if (typeof detail === 'string') {
      return { code: `http.${status}`, message: detail, detail: null };
    }
  }
  return {
    code: `http.${status}`,
    message: `the server refused this call (HTTP ${status})`,
    detail: body === null ? null : JSON.stringify(body).slice(0, 400),
  };
}

/** One JSON call. Resolves with the parsed body or rejects with a named ApiError. */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionToken();
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  if (token) headers.set(TOKEN_HEADER, token);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (err) {
    // A dead local server is the single most common state during development and it
    // must read as "the server is not there", not as an empty document.
    throw new ApiError(
      `could not reach the local server at ${path}`,
      'server.unreachable',
      0,
      String(err),
    );
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // The body is not JSON. That is a fact about the response, not a failure of
      // this call, so it is recorded rather than rethrown.
      body = await response.text().catch(() => null);
    }
    const { code, message, detail } = describe(response.status, body);
    throw new ApiError(message, code, response.status, detail);
  }

  return (await response.json()) as T;
}
