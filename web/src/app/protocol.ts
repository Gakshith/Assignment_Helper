// OWNER: the server strand. Replace the implementation; do not touch main.ts.
/**
 * The real ProtocolClient. WS for deltas, HTTP for snapshots.
 *
 * Invariant I4: the SERVER document is authoritative. This client never merges and
 * never reconciles. It sends a delta, the server accepts or rejects it, and every
 * accepted delta comes back over the socket - to the sender too - so that kernel.ts
 * adopts the server's snapshot rather than trusting its own optimism.
 *
 * Invariant I6: every timeout has a named, visible fallback. The reconnect budget is
 * 3 s x 5 attempts, the SAME numbers the server's ownership registry uses to decide
 * when a second tab may be promoted (assignment_helper/server/ws.py). If these two
 * drift apart, a tab gets promoted while its owner is still retrying. When the budget
 * is exhausted the client reports "disconnected from the local server" through
 * onDisconnect - the handler kernel.ts already registers, which raises an app-scope
 * Problem - and then STAYS DOWN. Editing is disabled and NOTHING IS QUEUED: a write
 * replayed against a document that moved on underneath it is exactly the blind merge
 * I4 exists to forbid.
 *
 * Invariant I5: no silent failure. Every rejected send rejects its promise with a named
 * error. No `|| default` anywhere in here hides a throw.
 *
 * Invariant I16: the token is held in memory for the lifetime of the client and put on
 * the wire as the `x-ah-token` header. The websocket handshake cannot carry a custom
 * header from a browser, so there it travels as ?t= - the same query parameter the
 * server already accepts - and is never logged or persisted by this module.
 */

import type { Delta, ProtocolClient, Snapshot } from './contracts';

/** I6, mirrored from assignment_helper/server/ws.py. Asserted by tests/unit/protocol.test.ts. */
export const RECONNECT_DELAY_MS = 3000;
export const RECONNECT_ATTEMPTS = 5;
export const RECONNECT_BUDGET_MS = RECONNECT_DELAY_MS * RECONNECT_ATTEMPTS;
export const DISCONNECT_REASON = 'disconnected from the local server';

export const TOKEN_HEADER = 'x-ah-token';

/** The slice of WebSocket this client uses, so a test can supply a fake. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Role changes, read-only banners and file-conflict prompts. NOT an error path: those
 *  all go to onDisconnect and from there to the kernel's problem sink. */
export interface Notice {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ProtocolOptions {
  token: string | null;
  /** Prefix for HTTP calls. Empty means same-origin relative, which is the browser case. */
  baseUrl?: string;
  /** ws:// origin. Derived from location when omitted. */
  wsUrl?: string;
  /** Per-tab identity. Survives a reconnect so this tab reclaims ownership (row 15 x I6). */
  clientId?: string;
  socketFactory?: (url: string) => SocketLike;
  fetchImpl?: typeof fetch;
}

export class ProtocolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function defaultClientId(): string {
  // sessionStorage, for the same reason the token lives there: it must die with the
  // tab, and it must survive F5 or a refresh would look like a brand-new second tab.
  const key = 'ah.client-id';
  const fresh = `tab-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    sessionStorage.setItem(key, fresh);
    return fresh;
  } catch (err) {
    // Not swallowed: without storage a refresh looks like a second tab and this tab
    // will come back read-only. The user gets to know why.
    console.error('could not persist the per-tab client id; a refresh may open read-only', err);
    return fresh;
  }
}

function defaultWsUrl(): string {
  if (typeof location === 'undefined') {
    throw new ProtocolError(
      'no location available to derive the websocket URL; pass wsUrl',
      'protocol.no-location',
    );
  }
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}`;
}

interface Pending {
  resolve: (version: number) => void;
  reject: (err: Error) => void;
}

export class LocalProtocolClient implements ProtocolClient {
  readonly name = 'local-protocol';

  #token: string | null;
  #baseUrl: string;
  #wsUrl: string;
  #clientId: string;
  #socketFactory: (url: string) => SocketLike;
  #fetch: typeof fetch | undefined;

  #socket: SocketLike | null = null;
  #connected = false;
  /** Set once the reconnect budget is spent. Never cleared: editing stays disabled. */
  #givenUp = false;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #seq = 0;
  #pending = new Map<number, Pending>();
  #openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];

  #deltaHandlers: ((d: Delta) => void)[] = [];
  #disconnectHandlers: ((reason: string) => void)[] = [];
  #noticeHandlers: ((n: Notice) => void)[] = [];

  #role: 'owner' | 'reader' = 'reader';
  #ownerClientId: string | null = null;

  constructor(opts: ProtocolOptions) {
    this.#token = opts.token;
    this.#baseUrl = opts.baseUrl ?? '';
    this.#wsUrl = opts.wsUrl ?? '';
    this.#clientId = opts.clientId ?? defaultClientId();
    this.#socketFactory =
      opts.socketFactory ??
      ((url: string) => new WebSocket(url) as unknown as SocketLike);
    this.#fetch = opts.fetchImpl;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get clientId(): string {
    return this.#clientId;
  }

  /** Row 15: false means this tab is a read-only follower. */
  get isOwner(): boolean {
    return this.#role === 'owner';
  }

  get ownerClientId(): string | null {
    return this.#ownerClientId;
  }

  // ------------------------------------------------------------ connect

  connect(): Promise<void> {
    if (this.#connected) return Promise.resolve();
    const waiter = new Promise<void>((resolve, reject) => {
      this.#openWaiters.push({ resolve, reject });
    });
    this.#open();
    return waiter;
  }

  #socketUrl(): string {
    const base = this.#wsUrl || defaultWsUrl();
    const params = new URLSearchParams({ client: this.#clientId });
    // A browser cannot set a header on a websocket handshake, so the token rides the
    // query string - the same parameter the server already reads.
    if (this.#token) params.set('t', this.#token);
    return `${base}/api/render/ws?${params.toString()}`;
  }

  #open(): void {
    if (this.#givenUp) return;
    let socket: SocketLike;
    try {
      socket = this.#socketFactory(this.#socketUrl());
    } catch (err) {
      this.#scheduleRetry(`could not open a websocket: ${String(err)}`);
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      this.#connected = true;
      this.#attempt = 0;
      const waiters = this.#openWaiters;
      this.#openWaiters = [];
      for (const w of waiters) w.resolve();
    };

    socket.onmessage = (ev: { data: unknown }) => this.#onMessage(ev.data);

    socket.onerror = () => {
      // Deliberately does not resolve or reject on its own: onclose always follows,
      // and the retry decision belongs in exactly one place.
    };

    socket.onclose = () => {
      const wasConnected = this.#connected;
      this.#connected = false;
      this.#socket = null;
      this.#failPending('protocol.disconnected', 'the connection closed before this edit was acknowledged');
      this.#scheduleRetry(wasConnected ? 'the connection closed' : 'the connection could not be established');
    };
  }

  #scheduleRetry(why: string): void {
    if (this.#givenUp || this.#retryTimer !== null) return;
    this.#attempt += 1;
    if (this.#attempt > RECONNECT_ATTEMPTS) {
      this.#giveUp(why);
      return;
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#open();
    }, RECONNECT_DELAY_MS);
  }

  #giveUp(why: string): void {
    this.#givenUp = true;
    this.#connected = false;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    const reason = `${DISCONNECT_REASON} (${why}; gave up after ${RECONNECT_ATTEMPTS} attempts ${RECONNECT_DELAY_MS / 1000}s apart)`;
    this.#failPending('protocol.disconnected', reason);
    const waiters = this.#openWaiters;
    this.#openWaiters = [];
    for (const w of waiters) w.reject(new ProtocolError(reason, 'protocol.disconnected'));
    // The kernel's registered handler is the only error path out of here (I5/I6).
    for (const h of this.#disconnectHandlers) h(reason);
  }

  #failPending(code: string, message: string): void {
    const pending = this.#pending;
    this.#pending = new Map();
    for (const p of pending.values()) p.reject(new ProtocolError(message, code));
  }

  // ------------------------------------------------------------ messages

  #onMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
    } catch (err) {
      throw new ProtocolError(
        `the server sent a frame that is not JSON: ${String(err)}`,
        'protocol.malformed',
      );
    }

    switch (message['type']) {
      case 'hello':
      case 'role': {
        this.#role = message['role'] === 'owner' ? 'owner' : 'reader';
        this.#ownerClientId = (message['owner_client_id'] as string | null) ?? null;
        this.#notice(message);
        return;
      }
      case 'delta': {
        const delta = message['delta'] as Delta | undefined;
        if (!delta) {
          throw new ProtocolError('a delta frame arrived with no delta', 'protocol.malformed');
        }
        for (const h of this.#deltaHandlers) h(delta);
        return;
      }
      case 'ack': {
        const p = this.#take(message['seq']);
        p?.resolve(Number(message['version']));
        return;
      }
      case 'nack': {
        const p = this.#take(message['seq']);
        const err = new ProtocolError(
          String(message['message'] ?? 'the server rejected this edit'),
          String(message['code'] ?? 'protocol.rejected'),
          message,
        );
        if (p) p.reject(err);
        else throw err; // an unsolicited rejection is still a failure, not noise
        return;
      }
      case 'denied': {
        // Retrying a bad token forever would just look like a dead server. Stop now,
        // with the server's own reason.
        this.#attempt = RECONNECT_ATTEMPTS + 1;
        this.#giveUp(String(message['message'] ?? message['code'] ?? 'rejected by the server'));
        return;
      }
      default: {
        this.#notice(message);
      }
    }
  }

  #take(seq: unknown): Pending | undefined {
    if (typeof seq !== 'number') return undefined;
    const p = this.#pending.get(seq);
    this.#pending.delete(seq);
    return p;
  }

  #notice(message: Record<string, unknown>): void {
    for (const h of this.#noticeHandlers) h(message as Notice);
  }

  // ------------------------------------------------------------ contract

  async snapshot(): Promise<Snapshot> {
    const fetchImpl = this.#fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new ProtocolError('no fetch implementation available', 'protocol.no-fetch');
    }
    const headers: Record<string, string> = {};
    if (this.#token) headers[TOKEN_HEADER] = this.#token;

    const response = await fetchImpl(`${this.#baseUrl}/api/render/snapshot`, { headers });
    if (!response.ok) {
      // No `|| default`, no empty document. A failed snapshot is a failed snapshot (I5).
      let detail: unknown = null;
      try {
        detail = await response.json();
      } catch {
        detail = await response.text();
      }
      throw new ProtocolError(
        `the server refused a snapshot (HTTP ${response.status})`,
        'protocol.snapshot-failed',
        detail,
      );
    }
    return (await response.json()) as Snapshot;
  }

  sendDelta(delta: Delta): Promise<void> {
    if (this.#givenUp) {
      return Promise.reject(
        new ProtocolError(
          `${DISCONNECT_REASON}; editing is disabled and nothing is queued`,
          'protocol.disconnected',
        ),
      );
    }
    const socket = this.#socket;
    if (!this.#connected || !socket) {
      // I6: NOTHING IS QUEUED while disconnected. A replayed write is a blind merge.
      return Promise.reject(
        new ProtocolError(
          'not connected to the local server; this edit was not queued',
          'protocol.not-connected',
        ),
      );
    }

    const seq = ++this.#seq;
    const settled = new Promise<number>((resolve, reject) => {
      this.#pending.set(seq, { resolve, reject });
    });
    try {
      socket.send(JSON.stringify({ type: 'delta', seq, delta }));
    } catch (err) {
      this.#pending.delete(seq);
      return Promise.reject(
        new ProtocolError(`could not send the edit: ${String(err)}`, 'protocol.send-failed'),
      );
    }
    return settled.then(() => undefined);
  }

  onRemoteDelta(handler: (d: Delta) => void): void {
    this.#deltaHandlers.push(handler);
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.#disconnectHandlers.push(handler);
  }

  /** Additive, and not an error path: roles, read-only banners, file-conflict prompts. */
  onNotice(handler: (n: Notice) => void): void {
    this.#noticeHandlers.push(handler);
  }

  /** Tests and teardown. Stops retrying without reporting a disconnect. */
  dispose(): void {
    this.#givenUp = true;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#socket?.close();
    this.#socket = null;
    this.#connected = false;
  }
}

export function createProtocol(opts: ProtocolOptions): LocalProtocolClient {
  return new LocalProtocolClient(opts);
}
