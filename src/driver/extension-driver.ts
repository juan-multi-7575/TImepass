import { WebSocketServer, WebSocket } from 'ws';
import { BrowserDriver, ActionPayload, ActionResult } from './driver.interface.js';

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

export class ExtensionDriver implements BrowserDriver {
  private wss: WebSocketServer | null = null;
  private clientSocket: WebSocket | null = null;
  private pendingRequests = new Map<string, (result: ActionResult<any>) => void>();
  /** Handles for the per-action timeout timers, cleared on reply so no
   * completed action leaks a 75s timer (the MCP server has no process.exit). */
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private eventListeners = new Map<string, ((data: any) => void)[]>();
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
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
    'get_page_info'
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

          ws.on('message', (data) => {
            try {
              const msg = JSON.parse(data.toString());

              if (msg.type === 'ping') return; // Ignore heartbeats

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
                resolver({ success: msg.success !== false, data: msg.response, error: msg.error });
                return;
              }

               if (msg.type) {
                 const listeners = this.eventListeners.get(msg.type) || [];
                 for (const fn of listeners) fn(msg);
               }
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
    const budget = typeof (payload as any).timeoutMs === 'number' && (payload as any).timeoutMs > 0
      ? (payload as any).timeoutMs
      : DEFAULT_ACTION_BUDGET_MS;
    const waitMs = budget + ACTION_GRACE_MS;

    return new Promise((resolve) => {
      this.pendingRequests.set(id, resolve);
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
          resolve({ success: false, error: `Action execution timed out after ${waitMs}ms waiting for extension.` });
        }
      }, waitMs);

      this.pendingTimers.set(id, timer);
    });
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
