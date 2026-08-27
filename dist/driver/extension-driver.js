import { WebSocketServer, WebSocket } from 'ws';
export class ExtensionDriver {
    wss = null;
    clientSocket = null;
    pendingRequests = new Map();
    eventListeners = new Map();
    port;
    constructor(port = 9876) {
        this.port = port;
    }
    async connect() {
        return new Promise((resolve, reject) => {
            try {
                this.wss = new WebSocketServer({ port: this.port });
                this.wss.on('connection', (ws) => {
                    console.log('[ExtensionDriver] Chrome extension connected over WebSocket.');
                    this.clientSocket = ws;
                    ws.on('message', (data) => {
                        try {
                            const msg = JSON.parse(data.toString());
                            if (msg.type === 'ping')
                                return; // Ignore heartbeats
                            if (msg.type === 'extension_log') {
                                const source = msg.source === 'background' ? 'Background' : 'Content';
                                const prefix = `[Extension:${source}:${msg.level.toUpperCase()}]`;
                                if (msg.level === 'error') {
                                    console.error(`\x1b[31m${prefix} ${msg.text}\x1b[0m`);
                                }
                                else if (msg.level === 'warn') {
                                    console.warn(`\x1b[33m${prefix} ${msg.text}\x1b[0m`);
                                }
                                else {
                                    console.log(`\x1b[90m${prefix} ${msg.text}\x1b[0m`);
                                }
                                return;
                            }
                            if (msg.id && this.pendingRequests.has(msg.id)) {
                                const resolver = this.pendingRequests.get(msg.id);
                                this.pendingRequests.delete(msg.id);
                                resolver({ success: msg.success !== false, data: msg.response, error: msg.error });
                                return;
                            }
                            if (msg.type) {
                                const listeners = this.eventListeners.get(msg.type) || [];
                                for (const fn of listeners)
                                    fn(msg);
                            }
                        }
                        catch (err) {
                            console.error('[ExtensionDriver] Error handling WS message:', err);
                        }
                    });
                    ws.on('close', () => {
                        console.log('[ExtensionDriver] Chrome extension disconnected.');
                        this.clientSocket = null;
                    });
                    // Resolve connect promise when extension client connects!
                    resolve();
                });
                this.wss.on('listening', () => {
                    console.log(`[ExtensionDriver] WebSocket server listening on ws://127.0.0.1:${this.port}`);
                    console.log('[ExtensionDriver] Waiting for Chrome extension connection...');
                    // Timeout safety: if client doesn't connect within 10s, resolve anyway so calls can retry
                    setTimeout(() => {
                        if (!this.clientSocket) {
                            console.warn('[ExtensionDriver] Warning: Chrome extension has not connected yet. Please ensure extension is loaded in Chrome.');
                            resolve();
                        }
                    }, 10000);
                });
                this.wss.on('error', (err) => {
                    reject(err);
                });
            }
            catch (err) {
                reject(err);
            }
        });
    }
    async executeAction(payload) {
        if (!this.clientSocket || this.clientSocket.readyState !== WebSocket.OPEN) {
            return { success: false, error: 'Extension not connected over WebSocket bridge.' };
        }
        const id = payload.id || `act_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        return new Promise((resolve) => {
            this.pendingRequests.set(id, resolve);
            this.clientSocket.send(JSON.stringify({ id, ...payload }));
            // Timeout safety
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    resolve({ success: false, error: 'Action execution timed out waiting for extension.' });
                }
            }, 60000);
        });
    }
    onEvent(event, callback) {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, []);
        }
        this.eventListeners.get(event).push(callback);
    }
    async close() {
        if (this.clientSocket) {
            this.clientSocket.close();
            this.clientSocket = null;
        }
        if (this.wss) {
            await new Promise((resolve) => this.wss.close(() => resolve()));
            this.wss = null;
        }
    }
}
//# sourceMappingURL=extension-driver.js.map