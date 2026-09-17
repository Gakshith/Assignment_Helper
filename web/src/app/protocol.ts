// OWNER: the server strand. Replace the implementation; do not touch main.ts.
import { makeStubProtocol } from './stubs';
import type { ProtocolClient, Document } from './contracts';

const EMPTY_DOC: Document = { schema_version: 1, id: 'bootstrap', title: '', blocks: [] };

export function createProtocol(_opts: { token: string | null }): ProtocolClient {
  return makeStubProtocol(EMPTY_DOC);
}
