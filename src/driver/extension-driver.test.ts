import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionDriver } from './extension-driver.js';

/**
 * The action reply and the event stream are separate messages over one socket.
 * These tests pin the rule that stopped a healthy turn from being abandoned:
 * a request is only given up on after the caller's own budget *plus* grace, so
 * a late reply is treated as the tail of a turn rather than as a failure.
 */

/** A driver with a socket stubbed in, so no server is ever opened. */
function driverWithSocket() {
  const driver = new ExtensionDriver();
  const send = vi.fn();
  (driver as any).clientSocket = { readyState: 1, send };
  return { driver, send };
}

describe('ExtensionDriver.executeAction timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not abandon a request that asked for more than the old fixed 60s', async () => {
    vi.useFakeTimers();
    const { driver, send } = driverWithSocket();

    const pending = driver.executeAction({ action: 'read_history', timeoutMs: 120000 } as any);
    let settled = false;
    void pending.then(() => { settled = true; });

    // 60s is exactly where the hardcoded timer used to fire. A caller that
    // asked for two minutes must still be waiting here.
    await vi.advanceTimersByTimeAsync(60000);
    expect(settled).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);

    // It gives up only after the caller's budget plus the grace window.
    await vi.advanceTimersByTimeAsync(75000);
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  it('gives up sooner than the old fixed 60s when the caller asks for less', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();

    const pending = driver.executeAction({ action: 'read_history', timeoutMs: 1000 } as any);
    let settled = false;
    void pending.then(() => { settled = true; });

    // 1000ms budget + 15000ms grace = 16000ms, far short of the old 60s.
    await vi.advanceTimersByTimeAsync(20000);
    expect(settled).toBe(true);
    await expect(pending).resolves.toMatchObject({ success: false });
  });

  it('names the wait it actually made, so the error is diagnosable', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();

    const pending = driver.executeAction({ action: 'read_history', timeoutMs: 5000 } as any);
    await vi.advanceTimersByTimeAsync(20000);

    const result = await pending;
    expect(result.success).toBe(false);
    expect(result.error).toContain('20000ms');
  });

  it('settles the moment a reply lands, without waiting out the timer', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();

    const pending = driver.executeAction({ action: 'read_history', timeoutMs: 120000 } as any);

    // Simulate the extension replying, the way the socket handler does.
    const sent = JSON.parse(((driver as any).clientSocket.send as any).mock.calls[0][0]);
    const resolver = (driver as any).pendingRequests.get(sent.id);
    (driver as any).pendingRequests.delete(sent.id);
    resolver({ success: true, data: { history: [] } });

    await expect(pending).resolves.toMatchObject({ success: true });
  });
});

describe('ExtensionDriver timer hygiene', () => {
  let drivers: ExtensionDriver[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const d of drivers.splice(0)) {
      await d.close().catch(() => {});
    }
  });

  it('clears the per-action timeout when the reply lands', async () => {
    // The message handler (the only path that clears the timer) is installed
    // on a real connection, so drive a real round-trip: connect a client, let
    // it answer the action the driver sends.
    const driver = new ExtensionDriver(0);
    drivers.push(driver);

    const connectPromise = driver.connect();
    await new Promise((r) => setTimeout(r, 0));
    const port = ((driver as any).wss as any).address().port;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && msg.action) {
        client.send(JSON.stringify({ id: msg.id, success: true, response: { history: [] } }));
      }
    });
    await new Promise<void>((res) => client.on('open', res));
    await connectPromise;

    const pending = driver.executeAction({ action: 'read_history', timeoutMs: 120000 });
    // The timer is armed while the action is in flight…
    expect((driver as any).pendingTimers.size).toBe(1);

    // …and the reply path must clear it, otherwise every completed action
    // leaves a live 75s timer holding its closure — invisible to the CLI
    // (process.exit) but fatal to the MCP server, which never exits.
    await expect(pending).resolves.toMatchObject({ success: true });
    expect((driver as any).pendingTimers.size).toBe(0);

    client.close();
  });

  it('drops the timer entry when the action times out', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();

    const pending = driver.executeAction({ action: 'read_history', timeoutMs: 1000 } as any);
    expect((driver as any).pendingTimers.size).toBe(1);

    await vi.advanceTimersByTimeAsync(20000);

    await expect(pending).resolves.toMatchObject({ success: false });
    expect((driver as any).pendingTimers.size).toBe(0);
  });
});

describe('ExtensionDriver socket ownership', () => {
  let drivers: ExtensionDriver[] = [];

  afterEach(async () => {
    for (const d of drivers.splice(0)) {
      await d.close().catch(() => {});
    }
  });

  it('only clears the tracked socket when IT closes, not an orphan', async () => {
    // A real server, so the production close handler actually fires. This
    // reproduces the reconnect race: the extension dials in twice, the second
    // connection becomes the tracked socket, and the first is left orphaned.
    const driver = new ExtensionDriver(0);
    drivers.push(driver);

    const connectPromise = driver.connect();
    await new Promise((r) => setTimeout(r, 0));

    const server = (driver as any).wss as any;
    const port = server.address().port;

    // The server-side socket objects are what the driver tracks, so capture
    // them from the server's own `connection` events (they are NOT the same
    // objects as our client-side WebSocket handles).
    const serverSockets: WebSocket[] = [];
    server.on('connection', (ws: WebSocket) => serverSockets.push(ws));

    const first = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => first.on('open', res));
    await new Promise((r) => setTimeout(r, 50));
    expect(serverSockets.length).toBe(1);
    expect((driver as any).clientSocket).toBe(serverSockets[0]);

    // A reconnect arrives; it takes over clientSocket and leaves serverSockets[0]
    // orphaned but still open.
    const second = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => second.on('open', res));
    await new Promise((r) => setTimeout(r, 50));
    expect(serverSockets.length).toBe(2);
    expect((driver as any).clientSocket).toBe(serverSockets[1]);

    // The orphan disconnects first. Before the fix the close handler ran
    // `this.clientSocket = null` unconditionally, nulling out the tracked
    // socket and breaking every subsequent action with "not connected".
    first.close();
    await new Promise<void>((res) => first.on('close', res));
    await new Promise((r) => setTimeout(r, 50));
    expect((driver as any).clientSocket).toBe(serverSockets[1]);

    // Now the tracked socket closes — that is the real disconnect.
    second.close();
    await new Promise<void>((res) => second.on('close', res));
    await new Promise((r) => setTimeout(r, 50));
    expect((driver as any).clientSocket).toBeNull();

    await connectPromise;
  });
});