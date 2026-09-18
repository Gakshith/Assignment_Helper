/**
 * The export wire format. The client half of `assignment_helper/routers/export.py`.
 *
 * Pages travel as raw RGBA in the request body, one page per request. They are not
 * base64'd and not JSON-wrapped: 15 MB of pixels through a JSON encoder costs more on
 * its own than the whole of gate G7 (raw POST + decode <= 40 ms/page).
 */

/** Header names for the page POST. Lower-case because fetch normalises them anyway. */
export const PAGE_HEADERS = {
  index: 'x-ah-page-index',
  width: 'x-ah-page-w',
  height: 'x-ah-page-h',
} as const;

/** Invariant I16: the session token on every request. */
export const TOKEN_HEADER = 'x-ah-token';

export interface BeginRequest {
  readonly dpi: number;
  readonly page_count: number;
  readonly page_w_px: number;
  readonly page_h_px: number;
  readonly document_path: string | null;
  readonly title: string;
  readonly seed: number;
  /** Plan §C.5.4. Non-empty means the server refuses to open the session at all. */
  readonly blocked_block_ids: readonly string[];
}

export interface BeginResponse {
  readonly session_id: string;
  readonly expected_page_bytes: number;
  readonly no_artifacts: boolean;
}

export interface PageResponse {
  readonly index: number;
  readonly bytes: number;
  readonly receive_ms: number;
}

export interface FinishResponse {
  readonly path: string;
  readonly size_bytes: number;
  readonly pages: number;
  readonly producer: string;
  readonly artifacts: boolean;
  readonly revealed: boolean;
  readonly artifact_ms: readonly number[];
  readonly page_bytes: readonly number[];
  readonly oversized_pages: readonly number[];
}

/** The named-failure body every export route returns. Invariant I5. */
export interface ServerProblem {
  readonly scope: 'block' | 'page' | 'app';
  readonly code: string;
  readonly message: string;
  readonly block_id?: string | null;
  readonly detail?: string | null;
}
