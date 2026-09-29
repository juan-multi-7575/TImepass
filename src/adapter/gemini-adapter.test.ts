import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from './gemini-adapter.js';
import type { ActionResult, BrowserDriver } from '../driver/driver.interface.js';
import type { StreamChunk } from './types.js';

class FakeDriver implements BrowserDriver {
  private listeners = new Map<string, ((data: any) => void)[]>();

  readonly executeAction = vi.fn(async () => {
    await Promise.resolve();
    this.emit('stream_delta', { type: 'stream_delta', delta: 'Hello ' });
    this.emit('stream_delta', { type: 'stream_delta', delta: 'world' });
    this.emit('turn_complete', { type: 'turn_complete', text: 'Hello world', chatId: 'chat-1' });

    return {
      success: true,
      data: {
        success: true,
        turnComplete: true,
        text: 'Hello world',
        chatId: 'chat-1'
      }
    } as ActionResult<any>;
  });

  connect(): Promise<void> {
    return Promise.resolve();
  }

  onEvent(event: string, callback: (data: any) => void): void {
    const listeners = this.listeners.get(event) || [];
    listeners.push(callback);
    this.listeners.set(event, listeners);
  }

  offEvent(event: string, callback: (data: any) => void): void {
    const listeners = this.listeners.get(event) || [];
    this.listeners.set(event, listeners.filter((listener) => listener !== callback));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  listenerCount(event: string): number {
    return (this.listeners.get(event) || []).length;
  }

  private emit(event: string, data: any): void {
    for (const listener of this.listeners.get(event) || []) {
      listener(data);
    }
  }
}

describe('GeminiAdapter.dumpDom', () => {
  const adapters: GeminiAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  /** Build an adapter whose driver answers dom_dump with one fixed payload. */
  function adapterAnswering(data: unknown): GeminiAdapter {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    (adapter as any).driver = {
      executeAction: async () => ({ success: true, data }) as ActionResult<any>,
      close: async () => {},
    };
    return adapter;
  }

  it('returns the outline the content script wrapped in result', async () => {
    const outline = { ok: true, url: 'https://gemini.google.com/app', title: 'Gemini', tree: { tag: 'body' } };
    const adapter = adapterAnswering({ success: true, result: outline });

    await expect(adapter.dumpDom('body')).resolves.toEqual(outline);
  });

  it('returns the outline itself when a build replies without the wrapper', async () => {
    const outline = { ok: true, url: 'https://gemini.google.com/app', title: 'Gemini', tree: { tag: 'body' } };
    const adapter = adapterAnswering(outline);

    await expect(adapter.dumpDom()).resolves.toEqual(outline);
  });

  it('throws when the driver reports a failure', async () => {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    (adapter as any).driver = {
      executeAction: async () => ({ success: false, error: 'Selector matched nothing: #nope' }) as ActionResult<any>,
      close: async () => {},
    };

    await expect(adapter.dumpDom('#nope')).rejects.toThrow('Selector matched nothing: #nope');
  });
});

describe('GeminiAdapter.stream', () => {
  const adapters: GeminiAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('forwards deltas emitted while starting an action', async () => {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    const driver = new FakeDriver();
    (adapter as any).driver = driver;
    const chunks: StreamChunk[] = [];

    const response = await adapter.stream('hello', {
      onChunk: (chunk) => chunks.push(chunk)
    });

    expect(chunks).toEqual([
      { delta: 'Hello ', accumulatedText: 'Hello ' },
      { delta: 'world', accumulatedText: 'Hello world' }
    ]);
    expect(response.text).toBe('Hello world');
    expect(response.chatId).toBe('chat-1');
    expect(driver.listenerCount('stream_delta')).toBe(0);
    expect(driver.listenerCount('turn_complete')).toBe(0);
  });
});

describe('partial answers', () => {
  const adapters: GeminiAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  /** Adapter whose driver replies with a fixed inject_and_send payload. */
  function adapterAnswering(data: unknown): GeminiAdapter {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    (adapter as any).driver = {
      executeAction: async () => ({ success: true, data }) as ActionResult<any>,
      close: async () => {}
    };
    return adapter;
  }

  it('marks a timed-out ask as partial', async () => {
    const adapter = adapterAnswering({
      success: true, turnComplete: true, text: 'half an ans', chatId: 'chat-1', partial: true
    });
    await expect(adapter.ask('hello')).resolves.toMatchObject({ text: 'half an ans', partial: true });
  });

  it('leaves a completed ask unmarked', async () => {
    const adapter = adapterAnswering({ success: true, turnComplete: true, text: 'all of it', chatId: 'chat-1' });
    await expect(adapter.ask('hello')).resolves.toMatchObject({ text: 'all of it', partial: false });
  });

  it('carries the flag through a streamed turn_complete', async () => {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    const listeners = new Map<string, ((d: any) => void)[]>();
    (adapter as any).driver = {
      // Never resolves, so only the event can finish the stream.
      executeAction: () => new Promise(() => {}),
      onEvent: (e: string, cb: any) => listeners.set(e, [...(listeners.get(e) || []), cb]),
      offEvent: (e: string, cb: any) => listeners.set(e, (listeners.get(e) || []).filter(l => l !== cb)),
      close: async () => {}
    };

    const pending = adapter.stream('hello');
    // Wait a tick for the listeners to be registered.
    await new Promise(r => setTimeout(r, 0));
    for (const cb of listeners.get('turn_complete') || []) {
      cb({ type: 'turn_complete', text: 'half an ans', chatId: 'chat-1', partial: true });
    }

    await expect(pending).resolves.toMatchObject({ text: 'half an ans', partial: true });
  });
});

describe('stream action/stream races', () => {
  const adapters: GeminiAdapter[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  /**
   * Driver whose `inject_and_send` reply lands after `replyAfterMs`, and which
   * relays no turn_complete at all — the shape of a reply that arrives late on
   * the action channel while the event channel stays quiet.
   */
  function lateReplyDriver(replyAfterMs: number, text: string) {
    const listeners = new Map<string, ((d: any) => void)[]>();
    return {
      executeAction: () => new Promise(resolve => {
        setTimeout(() => resolve({
          success: true,
          data: { success: true, turnComplete: true, text, chatId: 'chat-1' }
        }), replyAfterMs);
      }),
      onEvent: (e: string, cb: any) => listeners.set(e, [...(listeners.get(e) || []), cb]),
      offEvent: (e: string, cb: any) => listeners.set(e, (listeners.get(e) || []).filter(l => l !== cb)),
      close: async () => {}
    };
  }

  it('delivers the answer when the action reply lands after the page budget', async () => {
    vi.useFakeTimers();
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    // Page budget 60s, reply at 70s: exactly the case the fixed 60s action
    // timer used to abandon, and that the adapter's own timer used to beat.
    (adapter as any).driver = lateReplyDriver(70000, 'the whole answer');

    const pending = adapter.stream('hello', { timeoutMs: 60000 });

    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(15000);

    await expect(pending).resolves.toMatchObject({ text: 'the whole answer' });
  });

  it('settles from the action reply even when every delta was dropped', async () => {
    vi.useFakeTimers();
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    // No stream_delta is ever relayed, so `fullText` stays empty. The reply
    // still holds the finished answer and must not be discarded for that.
    (adapter as any).driver = lateReplyDriver(1000, 'the whole answer');

    const pending = adapter.stream('hello', { timeoutMs: 60000 });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toMatchObject({ text: 'the whole answer' });
  });

  it('does not let a later turn_complete clobber the settled answer', async () => {
    vi.useFakeTimers();
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    const listeners = new Map<string, ((d: any) => void)[]>();
    (adapter as any).driver = {
      executeAction: () => new Promise(resolve => {
        setTimeout(() => resolve({
          success: true,
          data: { success: true, turnComplete: true, text: 'the whole answer', chatId: 'chat-1' }
        }), 1000);
      }),
      onEvent: (e: string, cb: any) => listeners.set(e, [...(listeners.get(e) || []), cb]),
      offEvent: (e: string, cb: any) => listeners.set(e, (listeners.get(e) || []).filter(l => l !== cb)),
      close: async () => {}
    };

    const pending = adapter.stream('hello', { timeoutMs: 60000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toMatchObject({ text: 'the whole answer' });

    // A straggler event must be inert, not a second answer.
    const settled = await pending;
    for (const cb of listeners.get('turn_complete') || []) {
      cb({ type: 'turn_complete', text: 'a stale fragment' });
    }
    expect(settled.text).toBe('the whole answer');
  });
});
