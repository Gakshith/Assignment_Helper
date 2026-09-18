// OWNER: the chat strand.
import type { ChatPanel } from '../../app/contracts';
import { DockedChatPanel } from './panel';

/**
 * The token is read from sessionStorage rather than threaded through main.ts, which is
 * frozen. main.ts already put it there (invariant I16: delivered once in the URL,
 * stripped with history.replaceState, held in sessionStorage so F5 does not log you
 * out of your own app).
 */
function token(): string | null {
  try {
    return sessionStorage.getItem('ah.token');
  } catch {
    return null;
  }
}

export const chatPanel: ChatPanel = new DockedChatPanel(token());
export { DockedChatPanel } from './panel';
