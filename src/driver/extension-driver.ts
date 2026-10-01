import { WebSocketServer, WebSocket } from 'ws';
import { BrowserDriver, ActionPayload, ActionResult } from './driver.interface.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  DRIVER_BUILD_ID,
  readExtensionBuildInfo,
  type ExtensionBuildInfo,
} from './build-info.js';
import { isCompletedAnswer, type AnswerReplyEnvelope } from '../adapter/types.js';

/**
 * Headroom added to the caller's own budget before an action is abandoned.
 *
 * The action reply and the event stream are separate messages, so a reply that
 * arrives late is not a failure — it is the tail of a turn that was still
 * healthy. Giving up at the same instant the page does is what turned a
 * long-but-finishing answer into a thrown error with the real answer
 * discarded a few seconds later.
 */
const ACTION_GRACE_MS = 15000;

/** Budget assumed when a caller does not state one. */
const DEFAULT_ACTION_BUDGET_MS = 60000;

/**
 * How long the answer to an abandoned action stays collectable after the host
 * stopped waiting.
 *
 * Giving up on the *wait* is not the same as losing the work: the request is
 * already in flight and Gemini has already done the reasoning, so a reply that
 * lands late is a completed answer, not a failure. Retaining it long enough for
 * a follow-up `collectLate` turns a total loss into a short second call.
 */
const LATE_RESPONSE_TTL_MS = 30 * 60 * 1000;

/** Retained late replies and abandoned ids are both bounded; oldest goes first. */
const MAX_LATE_RESPONSES = 20;
const MAX_ABANDONED_IDS = 50;

/**
 * How long a freshly connected extension has to identify itself before the
 * handshake is treated as unsupported.
 *
 * An extension that predates the handshake will never send it, so this has to
 * expire rather than wait forever. It is a one-shot timer per connection and is
 * cleared on close, the same discipline the per-action timers follow.
 */
const HANDSHAKE_GRACE_MS = 3000;

/** Recorded findings are bounded too; a status call must not grow without end. */
const MAX_DIAGNOSTICS = 50;

/** One recorded finding about the bridge or the contract between its ends. */
export interface BridgeDiagnostic {
  kind:
    | 'build-mismatch'
    | 'action-missing'
    | 'envelope-non-conformant'
    | 'no-handshake'
    | 'manifest-unreadable';
  message: string;
  at: number;
}

/** What each end of the bridge believes it is, as far as the host can tell. */
export interface BridgeInfo {
  connected: boolean;
  protocolVersion: number;
  driverBuildId: string;
  /** The on-disk extension build, or null when the manifest was unreadable. */
  build: ExtensionBuildInfo | null;
  /** The build the connected extension reports, or null when it never said. */
  extensionBuildId: string | null;
  /**
   * `unknown` is the honest answer for an extension that never reported: a
   * worker still running old code looks exactly like one that predates the
   * handshake, and neither can be told apart from the host side alone.
   */
  buildMatch: 'match' | 'mismatch' | 'unknown';
  /** Every action this driver is willing to send. */
  knownActions: string[];
  /** Every action the connected extension says it can handle, or null. */
  extensionActions: string[] | null;
  /**
   * Actions the driver will send that the extension does not claim to handle.
   *
   * This is the version-independent detector: it catches a stale worker whose
   * dispatch table predates an edit even when nobody bumped `version`, which is
   * exactly how `recover_last_response` went missing without anyone noticing.
   */
  missingActions: string[];
  diagnostics: BridgeDiagnostic[];
}

export class ExtensionDriver implements BrowserDriver {
  private wss: WebSocketServer | null = null;
  private clientSocket: WebSocket | null = null;
  private pendingRequests = new Map<string, (result: ActionResult<any>) => void>();
  /** Handles for the per-action timeout timers, cleared on reply so no
   * completed action leaks a 75s timer (the MCP server has no process.exit). */
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Actions the host gave up waiting for, keyed by id. An id stays here until
   * its reply arrives (then it becomes a late response) or it ages out. */
  private abandoned = new Map<string, { at: number; action: string }>();
  /** Replies that arrived after their action was abandoned — the answers that
   * used to be dropped on the floor the instant the timeout fired. */
  private lateResponses = new Map<string, { at: number; action: string; result: ActionResult<any> }>();
  private eventListeners = new Map<string, ((data: any) => void)[]>();
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  /** The action each outstanding id belongs to, for diagnostics naming it. */
  private requestActions = new Map<string, string>();
  /** What the on-disk extension build looks like, refreshed on every connect. */
  private buildInfo: ExtensionBuildInfo | null = null;
  /** What the connected extension said about itself, or nulls when it said nothing. */
  private peer: {
    buildId: string | null;
    protocolVersion: number | null;
    actions: string[] | null;
    asyncActions: string[] | null;
  } = { buildId: null, protocolVersion: null, actions: null, asyncActions: null };
  /** Contract and skew findings, bounded and surfaced by {@link getBridgeInfo}. */
  private diagnostics: BridgeDiagnostic[] = [];
  /** Fires when a connected extension fails to identify itself in time. */
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private port: number;
  private readonly connectTimeoutMs = 10000;
  private readonly knownActions = new Set([
    'inject_and_send',
    'read_history',
    'select_history',
    'capture_screenshot',
    'dom_dump',
    'cookies:get',
    'cookies:restore',
    'file_upload',
    'get_page_info',
    'tab_list',
    'tab_create',
    'tab_close',
    'tab_switch',
    'tab_group_list',
    'click_button',
    // Re-reads the answer Gemini already saved for the last turn, without
    // re-asking. The freeze watchdog has always used this; exposing it lets a
    // host-side collect recover a turn whose reply never reached the socket.
    'recover_last_response'
  ]);

  constructor(port = 9876) {
    this.port = port;
  }

  async connect(port?: number): Promise<void> {
    if (typeof port === 'number') {
      this.port = port;
    }
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port });

        this.wss.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE') {
            this.connectRejectAndClear(new Error(`Port ${this.port} is already in use.`));
          } else {
            this.connectRejectAndClear(err);
          }
        });

        this.wss.on('connection', (ws) => {
          console.log('[ExtensionDriver] Chrome extension connected over WebSocket.');
          this.clientSocket = ws;
          // Re-read what is on disk for every connection: the manifest and the
          // sources are what the loaded build is supposed to match, and a
          // reload in between must not leave the previous answer standing.
          this.buildInfo = readExtensionBuildInfo();
          this.peer = { buildId: null, protocolVersion: null, actions: null, asyncActions: null };
          if (this.buildInfo.error) {
            this.record('manifest-unreadable', this.buildInfo.error);
          }
          this.sendBridgeHello(ws);
          this.armHandshakeGrace(ws);

          ws.on('message', (data) => {
            try {
              this.handleMessage(JSON.parse(data.toString()));
            } catch (err) {
              console.error('[ExtensionDriver] Error handling WS message:', err);
            }
          });

           ws.on('close', () => {
             console.log('[ExtensionDriver] Chrome extension disconnected.');
             // Only clear the shared clientSocket if this is the socket the
             // driver is actually tracking. An orphaned connection (from a
             // reconnect race) closing must not null out a still-live socket,
             // or every subsequent action fails with "not connected".
             if (this.clientSocket === ws) {
               this.clientSocket = null;
             }
             if (!this.wss) this.connectRejectAndClear(new Error('Extension disconnected before connect completed.'));
           });

           // Resolve connect promise when extension client connects!
           this.connectResolveAndClear();
         });

         this.wss.on('listening', () => {
           console.log(`[ExtensionDriver] WebSocket server listening on ws://127.0.0.1:${this.port}`);
           console.log('[ExtensionDriver] Waiting for Chrome extension connection...');

          this.connectTimeout = setTimeout(() => {
            if (!this.clientSocket) {
              const err = new Error('Extension not connected within timeout.');
              console.warn(`[ExtensionDriver] ${err.message} Please ensure extension is loaded in Chrome.`);
              this.connectRejectAndClear(err);
            }
          }, this.connectTimeoutMs);
        });

        this.connectResolve = resolve;
        this.connectReject = reject;
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Introduce ourselves to the extension and say which build we expect.
   *
   * Purely additive: a peer that predates this never reads it, and one that does
   * read it can only warn. Nothing here can fail an action.
   */
  private sendBridgeHello(ws: WebSocket): void {
    try {
      ws.send(JSON.stringify({
        type: 'bridge_hello',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        driverBuildId: DRIVER_BUILD_ID,
        expectedExtensionBuildId: this.buildInfo?.expectedBuildId ?? null,
        knownActions: [...this.knownActions],
      }));
    } catch (err) {
      console.warn('[ExtensionDriver] could not send the bridge handshake:', err);
    }
  }

  /** Start the one-shot timer that records an extension which never says hello. */
  private armHandshakeGrace(ws: WebSocket): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.clientSocket !== ws) return;
      if (this.peer.buildId !== null) return;
      // Silence here is ambiguous by nature: the extension may predate the
      // handshake, or its worker may still be running an older build. Either
      // way the host cannot tell which, so it says so instead of assuming.
      this.record(
        'no-handshake',
        'The extension connected but never identified itself. It either predates the handshake, or its '
        + 'service worker is still running an older build than the files on disk — Chrome keeps the worker '
        + 'script in memory, so reload the extension at chrome://extensions → Reload and retry. Until then '
        + 'every result comes from code that may not be the code on disk.'
      );
    }, HANDSHAKE_GRACE_MS);
    this.handshakeTimer.unref?.();
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /**
   * The on-disk build, read once and reused.
   *
   * Read lazily rather than only on connect so a status call answers the
   * question — "which build is this host expecting?" — even before anything has
   * connected, which is when an operator most wants to compare builds.
   */
  private ensureBuildInfo(): ExtensionBuildInfo | null {
    if (!this.buildInfo) {
      this.buildInfo = readExtensionBuildInfo();
    }
    return this.buildInfo;
  }

  /**
   * Take the extension's introduction: who it is, and what it can handle.
   *
   * The action list is the part that earns its keep. A worker running a stale
   * build reports the dispatch table it actually has, so an action that exists
   * in the driver's table but not in the extension's is detected here even when
   * nobody bumped `version`. That is precisely how `recover_last_response`
   * disappeared without anything failing loudly.
   */
  private handleBridgeHello(msg: any): void {
    this.clearHandshakeTimer();
    const strings = (value: unknown): string[] | null =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;

    this.peer = {
      buildId: typeof msg?.buildId === 'string' ? msg.buildId : null,
      protocolVersion: typeof msg?.protocolVersion === 'number' ? msg.protocolVersion : null,
      actions: strings(msg?.actions),
      asyncActions: strings(msg?.asyncActions),
    };

    const expected = this.ensureBuildInfo()?.expectedBuildId ?? null;
    if (this.peer.buildId && expected && this.peer.buildId !== expected) {
      this.record(
        'build-mismatch',
        `Build mismatch: the extension reports version ${this.peer.buildId} but extension/manifest.json says `
        + `${expected}. The worker is running code that is not the code on disk — reload it at `
        + 'chrome://extensions → Reload, then restart the DSH session.'
      );
    }

    for (const action of this.missingActions()) {
      this.record(
        'action-missing',
        `The connected extension does not list "${action}", which this driver sends. That action is very `
        + 'likely running a stale service worker: reload the extension at chrome://extensions → Reload.'
      );
    }
  }

  /** Actions the driver will send that the extension did not claim to handle. */
  private missingActions(): string[] {
    if (!this.peer.actions) return [];
    return [...this.knownActions].filter(action => !this.peer.actions!.includes(action));
  }

  /**
   * Record a reply that breaks the completed-answer envelope contract.
   *
   * This is the runtime enforcement the type cannot give: the extension is plain
   * JavaScript and the payload arrives as `any`, so nothing at build time can
   * stop a producer forgetting `turnComplete`. What matters is that the loss
   * stops being silent, so the finding names the action and says plainly
   * whether the answer still made it — "the adapter will drop this" is a
   * different fact from "delivered anyway, this producer predates the envelope".
   */
  private auditEnvelope(response: unknown, action: string): void {
    if (!response || typeof response !== 'object') return;
    const envelope = response as Record<string, unknown>;
    // Only completed answers are covered; a failure envelope has no contract.
    if (envelope.success !== true) return;
    if (envelope.turnComplete === true) return;
    // Nothing that looks like text means there is no answer to have lost.
    if (typeof envelope.text !== 'string') return;

    const delivered = isCompletedAnswer(response);
    this.record(
      'envelope-non-conformant',
      `Reply for "${action}" looks like a completed answer but omits turnComplete. `
      + (delivered
        ? 'It carries recovered, so the answer was delivered anyway — this producer predates the shared '
          + 'envelope in src/adapter/types.ts.'
        : 'It carries neither turnComplete nor recovered, so the adapter treats it as a failure and THE '
          + 'ANSWER IS LOST. Fix the producer in extension/ to set turnComplete: true.')
    );
  }

  private record(kind: BridgeDiagnostic['kind'], message: string): void {
    this.diagnostics.push({ kind, message, at: Date.now() });
    while (this.diagnostics.length > MAX_DIAGNOSTICS) {
      this.diagnostics.shift();
    }
    console.warn(`[ExtensionDriver] ${kind}: ${message}`);
  }

  /**
   * What each end of the bridge believes it is, and everything found wanting.
   *
   * This is the answer to "which build am I actually talking to", which during
   * the retest that produced issue #10 nobody could give.
   */
  getBridgeInfo(): BridgeInfo {
    const build = this.ensureBuildInfo();
    const expected = build?.expectedBuildId ?? null;
    const buildMatch: BridgeInfo['buildMatch'] =
      !expected || !this.peer.buildId
        ? 'unknown'
        : this.peer.buildId === expected
          ? 'match'
          : 'mismatch';

    return {
      connected: !!this.clientSocket && this.clientSocket.readyState === WebSocket.OPEN,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      driverBuildId: DRIVER_BUILD_ID,
      build,
      extensionBuildId: this.peer.buildId,
      buildMatch,
      knownActions: [...this.knownActions],
      extensionActions: this.peer.actions,
      missingActions: this.missingActions(),
      diagnostics: [...this.diagnostics],
    };
  }

  async executeAction<T>(payload: ActionPayload): Promise<ActionResult<T>> {
    if (!this.clientSocket || this.clientSocket.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'Extension not connected over WebSocket bridge.' };
    }
    if (!payload?.action || !this.knownActions.has(payload.action)) {
      return { success: false, error: `Unknown action: ${payload?.action ?? '(missing)'}` };
    }

    const id = payload.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    // Honour the caller's budget instead of a fixed 60s. A caller that asks for
    // two minutes must not have the request abandoned at one, and one that asks
    // for ten seconds should not pin a slot for a minute.
    const budget = typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
      ? payload.timeoutMs
      : DEFAULT_ACTION_BUDGET_MS;
    const waitMs = budget + ACTION_GRACE_MS;

    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
      // Remembered so a contract violation can name the action that broke it.
      this.requestActions.set(id, payload.action);
      this.clientSocket!.send(JSON.stringify({ id, ...payload }));

      // Timeout safety. Keep the handle: the reply path already deletes the
      // pending request, so clear the timer there too, otherwise every
      // completed action leaves a live 75s timer holding its closure (and the
      // MCP server, which has no process.exit, never frees it). The timeout
      // path clears its own entry as well, so a timed-out action leaks nothing.
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          this.pendingTimers.delete(id);
          this.requestActions.delete(id);
          // Giving up the *wait* is not losing the work: the request is already
          // in flight. Remember the id so that if the extension answers after
          // this point, the reply is kept rather than dropped for having no
          // pending entry left to resolve against.
          this.abandoned.set(id, { at: Date.now(), action: payload.action });
          this.pruneRetained();
          resolve({
            success: false,
            late: true,
            id,
            error: `Action execution timed out after ${waitMs}ms waiting for extension.`
          });
        }
      }, waitMs);

      this.pendingTimers.set(id, timer);
    });
  }

  /**
   * Take the answer to an action the host already abandoned, when the extension
   * replied after the timeout. Returns null when nothing was retained, which is
   * the caller's cue to fall back to re-reading the saved conversation.
   */
  async collectLate<T = unknown>(id?: string): Promise<ActionResult<T> | null> {
    this.pruneRetained();
    if (this.lateResponses.size === 0) return null;

    let key = id;
    if (key && !this.lateResponses.has(key)) return null; // An explicit id that was never retained.
    if (!key) {
      // Newest first: the answer to the turn that just timed out is the one a
      // caller means by "collect the last one".
      key = [...this.lateResponses.entries()]
        .reduce((newest, entry) => (entry[1].at > this.lateResponses.get(newest)!.at ? entry[0] : newest),
          [...this.lateResponses.keys()][0]);
    }

    const entry = this.lateResponses.get(key)!;
    // One-shot: a second collect must not hand the same text to another caller
    // as though it were a fresh response.
    this.lateResponses.delete(key);
    return entry.result as ActionResult<T>;
  }

  /**
   * One inbound socket message. Split out of the socket callback so the routing
   * rules — above all what happens to a reply whose request was given up on —
   * can be exercised without a live server.
   */
  private handleMessage(msg: any): void {
    if (msg.type === 'ping') return; // Ignore heartbeats

    // The extension's introduction. Handled before anything else because a
    // stale worker's dispatch table is the whole point of asking.
    if (msg.type === 'bridge_hello') {
      this.handleBridgeHello(msg);
      return;
    }
    // The extension comparing our advertised build against its own and finding
    // them different. Reported rather than guessed, so it shows up in the tool
    // output and not only in a devtools console nobody has open.
    if (msg.type === 'bridge_mismatch') {
      this.record(
        'build-mismatch',
        typeof msg.message === 'string' && msg.message
          ? `The extension reports a build mismatch: ${msg.message}`
          : 'The extension reports a build mismatch against the driver it is connected to.'
      );
      return;
    }

    if (msg.type === 'extension_log') {
      const source = msg.source === 'background' ? 'Background' : 'Content';
      const prefix = `[Extension:${source}:${msg.level.toUpperCase()}]`;
      if (msg.level === 'error') {
        console.error(`\x1b[31m${prefix} ${msg.text}\x1b[0m`);
      } else if (msg.level === 'warn') {
        console.warn(`\x1b[33m${prefix} ${msg.text}\x1b[0m`);
      } else {
        console.log(`\x1b[90m${prefix} ${msg.text}\x1b[0m`);
      }
      return;
    }

    if (msg.id && this.pendingRequests.has(msg.id)) {
      const resolver = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      const timer = this.pendingTimers.get(msg.id);
      if (timer) {
        clearTimeout(timer);
        this.pendingTimers.delete(msg.id);
      }
      const action = this.requestActions.get(msg.id) ?? 'unknown action';
      this.requestActions.delete(msg.id);
      this.auditEnvelope(msg.response, action);
      resolver({ success: msg.success !== false, data: msg.response, error: msg.error, id: msg.id });
      return;
    }

    // A reply for an action the host already gave up on. The id used to be
    // deleted when the timeout fired, so a finished answer arriving here
    // matched nothing and was dropped silently: the reasoning was already paid
    // for, and thrown away.
    if (msg.id && this.abandoned.has(msg.id)) {
      const entry = this.abandoned.get(msg.id)!;
      this.abandoned.delete(msg.id);
      this.auditEnvelope(msg.response, entry.action);
      this.lateResponses.set(msg.id, {
        at: Date.now(),
        action: entry.action,
        result: { success: msg.success !== false, data: msg.response, error: msg.error, id: msg.id, late: true }
      });
      this.pruneRetained();
      return;
    }

    if (msg.type) {
      const listeners = this.eventListeners.get(msg.type) || [];
      for (const fn of listeners) fn(msg);
    }
  }

  /** Drop retained entries that have aged out or exceeded their cap. */
  private pruneRetained(): void {
    const now = Date.now();
    for (const [id, entry] of this.abandoned) {
      if (now - entry.at > LATE_RESPONSE_TTL_MS) this.abandoned.delete(id);
    }
    for (const [id, entry] of this.lateResponses) {
      if (now - entry.at > LATE_RESPONSE_TTL_MS) this.lateResponses.delete(id);
    }
    // Map iteration is insertion-ordered, so the first key is the oldest.
    while (this.abandoned.size > MAX_ABANDONED_IDS) {
      this.abandoned.delete(this.abandoned.keys().next().value as string);
    }
    while (this.lateResponses.size > MAX_LATE_RESPONSES) {
      this.lateResponses.delete(this.lateResponses.keys().next().value as string);
    }
  }

  onEvent(event: string, callback: (data: any) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event)!.push(callback);
  }

  offEvent(event: string, callback: (data: any) => void): void {
    const listeners = this.eventListeners.get(event) || [];
    this.eventListeners.set(event, listeners.filter((listener) => listener !== callback));
    if (listeners.length === 1 && callback === listeners[0]) {
      this.eventListeners.delete(event);
    }
  }

  async close(): Promise<void> {
    this.clearHandshakeTimer();
    this.requestActions.clear();
    if (this.clientSocket) {
      this.clientSocket.close();
      this.clientSocket = null;
    }
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    this.connectResolveAndClear();
  }

  private connectResolveAndClear(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    const resolve = this.connectResolve;
    this.connectResolve = null;
    this.connectReject = null;
    resolve?.();
  }

  private connectRejectAndClear(err: Error): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    const reject = this.connectReject;
    this.connectResolve = null;
    this.connectReject = null;
    reject?.(err);
  }
}
