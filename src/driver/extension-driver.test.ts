import { afterEach, describe, expect, it, vi } from 'vitest';
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
