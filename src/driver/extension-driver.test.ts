import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { ExtensionDriver, type BridgeDiagnostic } from './extension-driver.js';
import { readExtensionBuildInfo } from './build-info.js';

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
  // `close` is here because close() is exercised: the handshake timer must not
  // outlive the bridge, and the driver does close the socket on the way out.
  (driver as any).clientSocket = { readyState: 1, send, close: vi.fn() };
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

describe('ExtensionDriver late responses', () => {
  let drivers: ExtensionDriver[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const d of drivers.splice(0)) {
      await d.close().catch(() => {});
    }
  });

  /**
   * Drive an action past its timeout and *then* deliver the reply the
   * extension would send — the exact sequence that used to throw the finished
   * answer away.
   */
  async function abandonedThenReplied(reply: any, id?: string) {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();
    const pending = driver.executeAction({ action: 'inject_and_send', timeoutMs: 1000, id } as any);
    // 1000ms budget + 15000ms grace: the host stops waiting here.
    await vi.advanceTimersByTimeAsync(20000);
    const result = await pending;
    expect(result).toMatchObject({ success: false, late: true });
    (driver as any).handleMessage({ id: result.id, ...reply });
    return { driver, result };
  }

  it('marks a timed-out action as late and hands back the id to collect by', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();

    const pending = driver.executeAction({ action: 'inject_and_send', timeoutMs: 1000 } as any);
    await vi.advanceTimersByTimeAsync(20000);

    const result = await pending;
    expect(result).toMatchObject({ success: false, late: true });
    // Without the id the caller has no handle on the turn it just abandoned.
    expect(result.id).toBeTruthy();
  });

  it('keeps the answer that arrives after the host gave up', async () => {
    const { driver } = await abandonedThenReplied({
      success: true,
      response: { success: true, turnComplete: true, text: 'the whole answer', chatId: 'chat-1' }
    });

    const collected = await driver.collectLate();
    expect(collected).toMatchObject({ success: true, late: true });
    expect((collected as any).data).toMatchObject({ text: 'the whole answer', chatId: 'chat-1' });
  });

  it('collects by id and hands the answer out only once', async () => {
    const { driver, result } = await abandonedThenReplied({
      success: true,
      response: { success: true, turnComplete: true, text: 'the whole answer' }
    });

    await expect(driver.collectLate(result.id)).resolves.toMatchObject({ success: true });
    // A second collect must not replay the same text as though it were fresh.
    await expect(driver.collectLate(result.id)).resolves.toBeNull();
    await expect(driver.collectLate()).resolves.toBeNull();
  });

  it('reports a clear miss when nothing was retained', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();

    await expect(driver.collectLate('act_never_existed')).resolves.toBeNull();
    await expect(driver.collectLate()).resolves.toBeNull();
  });

  it('ignores a reply for an id it never sent', async () => {
    const { driver } = driverWithSocket();

    (driver as any).handleMessage({ id: 'act_not_ours', success: true, response: { text: 'a stray reply' } });

    await expect(driver.collectLate('act_not_ours')).resolves.toBeNull();
    expect((driver as any).lateResponses.size).toBe(0);
  });

  it('routes a reply for a live action straight back to its caller', async () => {
    vi.useFakeTimers();
    const { driver, send } = driverWithSocket();

    const pending = driver.executeAction({ action: 'read_history', timeoutMs: 5000 } as any);
    const { id } = JSON.parse(send.mock.calls[0][0]);
    (driver as any).handleMessage({ id, success: true, response: { history: [] } });

    await expect(pending).resolves.toMatchObject({ success: true, id });
    expect((driver as any).lateResponses.size).toBe(0);
  });

  it('forgets a retained answer once it is too old to be the turn in question', async () => {
    const { driver } = await abandonedThenReplied({
      success: true,
      response: { success: true, turnComplete: true, text: 'a stale answer' }
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    await expect(driver.collectLate()).resolves.toBeNull();
  });

  it('bounds what it retains so a long session cannot grow without limit', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();

    for (let i = 0; i < 25; i++) {
      const pending = driver.executeAction({ action: 'inject_and_send', timeoutMs: 1000, id: `act_${i}` } as any);
      await vi.advanceTimersByTimeAsync(20000);
      await pending;
      (driver as any).handleMessage({ id: `act_${i}`, success: true, response: { text: `answer ${i}` } });
    }

    // Oldest evicted, newest kept.
    await expect(driver.collectLate('act_0')).resolves.toBeNull();
    await expect(driver.collectLate('act_24')).resolves.toMatchObject({ success: true });
  });

  it('retains the answer over a real socket, not just through the handler', async () => {
    // The routing rules above are exercised on the extracted handler; this one
    // proves the reply actually reaches it, so a reply arriving after the
    // timeout is kept end to end rather than dropped at the socket boundary.
    const driver = new ExtensionDriver(0);
    drivers.push(driver);

    const connectPromise = driver.connect();
    await new Promise((r) => setTimeout(r, 0));
    const port = ((driver as any).wss as any).address().port;

    let receivedId = '';
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && msg.action) receivedId = msg.id; // Hold the reply back on purpose.
    });
    await new Promise<void>((res) => client.on('open', res));
    await connectPromise;

    vi.useFakeTimers();

    const pending = driver.executeAction({ action: 'inject_and_send', timeoutMs: 1000 });
    // Let the real socket deliver the outbound action, then stop waiting.
    for (let i = 0; i < 20 && !receivedId; i++) {
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(receivedId).toBeTruthy();

    await vi.advanceTimersByTimeAsync(20000);
    await expect(pending).resolves.toMatchObject({ success: false, late: true, id: receivedId });

    // The extension answers now, long after the host stopped waiting.
    client.send(JSON.stringify({
      id: receivedId,
      success: true,
      response: { success: true, turnComplete: true, text: 'the whole answer', chatId: 'chat-1' }
    }));
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(5);
    }

    const collected = await driver.collectLate(receivedId);
    expect(collected).toMatchObject({ success: true, late: true });
    expect((collected as any).data).toMatchObject({ text: 'the whole answer' });

    client.close();
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

/**
 * The build handshake (issue #10).
 *
 * The retest these tests come from was run against a service worker still
 * executing an older build: the on-disk `background.js` had
 * `recover_last_response`, the live worker did not, and nothing said so. A whole
 * recovery path was therefore never exercised while the results were trusted.
 *
 * The version comparison catches a mismatch someone remembered to publish. The
 * action-table audit is the one that matters, because it catches a stale worker
 * even when nobody bumped `version` — which is what actually happened.
 */
describe('ExtensionDriver build handshake', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Feed the driver an extension introduction, as the socket handler would. */
  function hello(driver: ReturnType<typeof driverWithSocket>['driver'], msg: Record<string, unknown>) {
    (driver as any).handleMessage({ type: 'bridge_hello', ...msg });
  }

  it('reports a mismatch when the extension runs a different build than the files on disk', () => {
    const { driver } = driverWithSocket();
    const expected = readExtensionBuildInfo().expectedBuildId;

    hello(driver, { buildId: '0.0.1-stale', actions: [] });

    const info = driver.getBridgeInfo();
    expect(info.buildMatch).toBe('mismatch');
    expect(info.extensionBuildId).toBe('0.0.1-stale');
    expect(info.build?.expectedBuildId).toBe(expected);
    const finding = info.diagnostics.find(d => d.kind === 'build-mismatch');
    expect(finding).toBeTruthy();
    // The message has to say how to fix it, not just that it is wrong.
    expect(finding!.message).toMatch(/chrome:\/\/extensions/);
  });

  it('confirms a match when the extension reports the build on disk', () => {
    const { driver } = driverWithSocket();
    const expected = readExtensionBuildInfo().expectedBuildId;

    hello(driver, { buildId: expected, actions: [] });

    expect(driver.getBridgeInfo().buildMatch).toBe('match');
    expect(driver.getBridgeInfo().diagnostics.filter(d => d.kind === 'build-mismatch')).toHaveLength(0);
  });

  it('names the action a stale worker cannot handle', () => {
    const { driver } = driverWithSocket();
    const all = driver.getBridgeInfo().knownActions;

    // The live worker's dispatch table, one edit behind the files on disk.
    hello(driver, {
      buildId: readExtensionBuildInfo().expectedBuildId,
      actions: all.filter(action => action !== 'recover_last_response'),
    });

    const info = driver.getBridgeInfo();
    expect(info.missingActions).toEqual(['recover_last_response']);
    const finding = info.diagnostics.find(d => d.kind === 'action-missing');
    expect(finding?.message).toContain('recover_last_response');
    expect(finding?.message).toMatch(/chrome:\/\/extensions/);
  });

  it('says nothing about actions when the extension never listed any', () => {
    // An old build has no action list at all. Absent is not "handles nothing",
    // so the driver must not invent a pile of missing-action findings.
    const { driver } = driverWithSocket();
    hello(driver, { buildId: '0.9.0' });

    expect(driver.getBridgeInfo().missingActions).toEqual([]);
    expect(driver.getBridgeInfo().extensionActions).toBeNull();
  });

  it('reports unknown rather than matching when nothing introduced itself', () => {
    const { driver } = driverWithSocket();

    const info = driver.getBridgeInfo();
    expect(info.buildMatch).toBe('unknown');
    expect(info.extensionBuildId).toBeNull();
  });

  it('warns once the grace expires on an extension that never says hello', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();
    (driver as any).armHandshakeGrace((driver as any).clientSocket);

    expect(driver.getBridgeInfo().diagnostics).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3000);

    const finding = driver.getBridgeInfo().diagnostics.find(d => d.kind === 'no-handshake');
    expect(finding).toBeTruthy();
    expect(finding!.message).toMatch(/chrome:\/\/extensions/);
  });

  it('stays silent on the grace timer once the extension has introduced itself', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();
    (driver as any).armHandshakeGrace((driver as any).clientSocket);
    hello(driver, { buildId: readExtensionBuildInfo().expectedBuildId, actions: [] });

    await vi.advanceTimersByTimeAsync(3000);

    expect(driver.getBridgeInfo().diagnostics.filter(d => d.kind === 'no-handshake')).toHaveLength(0);
  });

  it('leaves no handshake timer behind when the bridge closes', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();
    (driver as any).armHandshakeGrace((driver as any).clientSocket);

    await driver.close();

    // The codebase has an explicit rule about timers outliving their work; the
    // handshake timer is held to it.
    expect((driver as any).handshakeTimer).toBeNull();
  });

  it('records a mismatch the extension reported about itself', () => {
    const { driver } = driverWithSocket();

    (driver as any).handleMessage({ type: 'bridge_mismatch', message: 'worker says 1.0.0, host says 1.1.0' });

    const finding = driver.getBridgeInfo().diagnostics.find(d => d.kind === 'build-mismatch');
    expect(finding?.message).toContain('1.0.0');
    expect(finding?.message).toContain('1.1.0');
  });
});

/**
 * Runtime enforcement of the completed-answer envelope, which the type cannot
 * give: the extension is plain JavaScript and the payload arrives as `any`, so
 * nothing at build time stops a producer forgetting `turnComplete`.
 *
 * What matters is that the loss stops being silent, so each finding names the
 * action and says whether the answer still reached the caller.
 */
describe('ExtensionDriver envelope conformance', () => {
  /** Run one action to completion with a reply, then return the findings. */
  async function replyWith(
    driver: ExtensionDriver,
    action: string,
    response: unknown
  ): Promise<BridgeDiagnostic[]> {
    const pending = driver.executeAction({ action, timeoutMs: 1000 });
    const sent = JSON.parse(((driver as any).clientSocket.send as any).mock.calls[0][0]);
    (driver as any).handleMessage({ id: sent.id, success: true, response });
    await pending;
    return driver.getBridgeInfo().diagnostics;
  }

  it('says the answer was lost when a completed reply omits turnComplete entirely', async () => {
    const { driver } = driverWithSocket();

    const findings = await replyWith(driver, 'inject_and_send', {
      success: true, text: 'Blue', chatId: 'chat-1'
    });

    const finding = findings.find(d => d.kind === 'envelope-non-conformant');
    expect(finding).toBeTruthy();
    // Names the action, and says the answer did not survive.
    expect(finding!.message).toContain('inject_and_send');
    expect(finding!.message).toMatch(/ANSWER IS LOST/);
  });

  it('says the answer was delivered anyway when the legacy recovered shape arrives', async () => {
    const { driver } = driverWithSocket();

    const findings = await replyWith(driver, 'inject_and_send', {
      success: true, recovered: true, text: 'Blue', chatId: 'chat-1'
    });

    const finding = findings.find(d => d.kind === 'envelope-non-conformant');
    expect(finding).toBeTruthy();
    expect(finding!.message).toMatch(/delivered anyway/);
    expect(finding!.message).not.toMatch(/ANSWER IS LOST/);
  });

  it('does not flag a reply that honours the contract', async () => {
    const { driver } = driverWithSocket();

    const findings = await replyWith(driver, 'inject_and_send', {
      success: true, turnComplete: true, text: 'Tokyo', chatId: 'chat-1'
    });

    expect(findings.filter(d => d.kind === 'envelope-non-conformant')).toHaveLength(0);
  });

  it('does not flag a failure envelope, which has no contract to break', async () => {
    const { driver } = driverWithSocket();

    const findings = await replyWith(driver, 'inject_and_send', {
      success: false, error: 'Input editor not found'
    });

    expect(findings.filter(d => d.kind === 'envelope-non-conformant')).toHaveLength(0);
  });

  it('checks a late reply too, naming the action that was abandoned', async () => {
    vi.useFakeTimers();
    const { driver } = driverWithSocket();
    const pending = driver.executeAction({ action: 'inject_and_send', timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(20000);
    const result = await pending;
    expect(result).toMatchObject({ late: true });

    (driver as any).handleMessage({
      id: result.id,
      success: true,
      response: { success: true, text: 'the whole answer' }
    });

    const finding = driver.getBridgeInfo().diagnostics.find(d => d.kind === 'envelope-non-conformant');
    expect(finding?.message).toContain('inject_and_send');
    vi.useRealTimers();
  });
});