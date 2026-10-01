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

  async collectLate<T = unknown>(_id?: string): Promise<ActionResult<T> | null> {
    return null;
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

describe('GeminiAdapter.collectLastResponse', () => {
  const adapters: GeminiAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('hands back the answer the extension sent after the timeout', async () => {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    const collected: (string | undefined)[] = [];
    (adapter as any).driver = {
      executeAction: async () => ({
        success: false,
        late: true,
        id: 'act_timed_out',
        error: 'Action execution timed out after 75000ms waiting for extension.'
      }) as ActionResult<any>,
      collectLate: async (id?: string) => {
        collected.push(id);
        return {
          success: true,
          late: true,
          id: 'act_timed_out',
          data: { success: true, turnComplete: true, text: 'the whole answer', chatId: 'chat-1' }
        } as ActionResult<any>;
      },
      close: async () => {}
    };

    await expect(adapter.ask('a long prompt', { timeoutMs: 1000 })).rejects.toThrow(/timed out/);

    const recovered = await adapter.collectLastResponse();
    expect(recovered).toMatchObject({
      text: 'the whole answer',
      chatId: 'chat-1',
      recovered: true,
      recoveredFrom: 'late-reply'
    });
    // Collection must ask for the very id the timeout handed back.
    expect(collected).toContain('act_timed_out');
  });

  it('re-reads the saved conversation when no late reply was retained', async () => {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    const actions: string[] = [];
    (adapter as any).driver = {
      executeAction: async (payload: any) => {
        actions.push(payload.action);
        if (payload.action === 'recover_last_response') {
          return {
            success: true,
            data: { success: true, recovered: true, text: 'the saved answer', chatId: 'chat-9' }
          } as ActionResult<any>;
        }
        return { success: true, data: { success: true, turnComplete: true, text: 'live', chatId: 'chat-1' } } as ActionResult<any>;
      },
      collectLate: async () => null,
      close: async () => {}
    };

    await expect(adapter.collectLastResponse()).resolves.toMatchObject({
      text: 'the saved answer',
      chatId: 'chat-9',
      recovered: true,
      recoveredFrom: 'saved-conversation'
    });
    // Re-reading must not re-ask: the turn is not sent again.
    expect(actions).toContain('recover_last_response');
    expect(actions).not.toContain('inject_and_send');
  });

  it('says so plainly when neither the socket nor the page has the answer', async () => {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    (adapter as any).driver = {
      executeAction: async () => ({
        success: true,
        data: { success: false, error: 'the saved response never finished rendering' }
      }) as ActionResult<any>,
      collectLate: async () => null,
      close: async () => {}
    };

    await expect(adapter.collectLastResponse()).rejects.toThrow(/Nothing to collect/);
    await expect(adapter.collectLastResponse()).rejects.toThrow(/never finished rendering/);
  });

  it('names an opaque failure instead of collapsing it into one sentence', async () => {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    // An extension result carrying neither `error` nor `data.error`: this used
    // to be indistinguishable from every other failure mode.
    (adapter as any).driver = {
      executeAction: async () => ({ success: true, data: { success: false, turnComplete: false } }) as ActionResult<any>,
      collectLate: async () => null,
      close: async () => {}
    };

    await expect(adapter.ask('hello')).rejects.toThrow(/result had no error field/);
  });
});

describe('completed answers (issue #5)', () => {
  const adapters: GeminiAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  /**
   * Adapter whose driver replies to `inject_and_send` with one fixed payload —
   * the envelope exactly as a producer put it on the wire.
   */
  function adapterAnswering(data: unknown): GeminiAdapter {
    const adapter = new GeminiAdapter();
    adapters.push(adapter);
    (adapter as any).driver = {
      executeAction: async () => ({ success: true, data }) as ActionResult<any>,
      collectLate: async () => null,
      close: async () => {}
    };
    return adapter;
  }

  it('returns a recovered answer whose envelope omitted turnComplete', async () => {
    // The shape a stale extension build sent, and the one `recover_last_response`
    // still sends: a finished answer with no `turnComplete`. It used to be
    // classified as a failure, so the user got "Failed to get Gemini response."
    // instead of the correct text Gemini had already paid for.
    const adapter = adapterAnswering({
      success: true, recovered: true, text: 'Blue', chatId: 'https://gemini.google.com/app/xyz'
    });

    await expect(adapter.ask('what colour?')).resolves.toMatchObject({
      text: 'Blue',
      chatId: 'https://gemini.google.com/app/xyz'
    });
  });

  it('flags that answer as recovered, so the tool layer can say so', async () => {
    const adapter = adapterAnswering({ success: true, recovered: true, text: 'Blue' });

    await expect(adapter.ask('what colour?')).resolves.toMatchObject({
      text: 'Blue',
      recovered: true
    });
  });

  it('keeps accepting the canonical envelope unchanged', async () => {
    const adapter = adapterAnswering({
      success: true, turnComplete: true, text: 'Tokyo', chatId: 'chat-1'
    });

    await expect(adapter.ask('capital?')).resolves.toMatchObject({
      text: 'Tokyo',
      chatId: 'chat-1',
      recovered: false
    });
  });

  it('still rejects a turn that is merely in flight', async () => {
    // Tolerance must not turn silence about completion into completion: this
    // reply says the turn has NOT finished, so there is no answer to return.
    const adapter = adapterAnswering({ success: true, turnComplete: false, text: 'partial so far' });

    await expect(adapter.ask('long prompt')).rejects.toThrow(/Failed to get Gemini response/);
  });

  it('still rejects a recovered envelope with no text in it', async () => {
    const adapter = adapterAnswering({ success: true, recovered: true, text: '' });

    await expect(adapter.ask('long prompt')).rejects.toThrow(/Failed to get Gemini response/);
  });

  it('still rejects an explicit failure envelope', async () => {
    const adapter = adapterAnswering({ success: false, error: 'Input editor not found' });

    await expect(adapter.ask('hello')).rejects.toThrow('Input editor not found');
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
