import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { BrowserDriver } from '../driver/driver.interface.js';
import { ExtensionDriver } from '../driver/extension-driver.js';
import { ComponentRegistry } from '../components/registry.js';
import { PromptInputHandler } from '../components/prompt-input.js';
import { SendButtonHandler } from '../components/send-button.js';
import { ModelPickerHandler } from '../components/model-picker.js';
import { ImageUploaderHandler } from '../components/image-uploader.js';
import { ResponseStreamerHandler } from '../components/response-streamer.js';
import { GeminiOptions, GeminiResponse, StreamChunk, AnswerReplyEnvelope, isCompletedAnswer } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Conversation reported when a reply carries no id of its own. */
const DEFAULT_CHAT_ID = 'https://gemini.google.com/app';

/**
 * Headroom above the page-side budget before the adapter abandons a stream.
 * Must exceed the driver's own grace so the driver's more specific error wins
 * the race; see ACTION_GRACE_MS in extension-driver.ts.
 */
const STREAM_GRACE_MS = 20000;

export class GeminiAdapter {
  private driver: BrowserDriver;
  private registry: ComponentRegistry;
  private defaultOptions: GeminiOptions;
  /**
   * The action the host gave up waiting for, if any. A timed-out ask is not
   * necessarily lost — the extension goes on to finish the turn — so the id is
   * kept for collectLastResponse() to pick the answer up with.
   */
  private abandonedAction: { id: string; at: number } | null = null;

  constructor(options: GeminiOptions = {}) {
    const merged = { ...options };
    const model = merged.model ?? merged.modelId ?? 'flash';

    this.defaultOptions = {
      driver: 'extension',
      model,
      timeoutMs: 60000,
      ...merged
    };

    this.driver = new ExtensionDriver();
    this.registry = new ComponentRegistry();
    this.registerDefaultComponents();
  }

  private registerDefaultComponents(): void {
    this.registry.register(new PromptInputHandler());
    this.registry.register(new SendButtonHandler());
    this.registry.register(new ModelPickerHandler());
    this.registry.register(new ImageUploaderHandler());
    this.registry.register(new ResponseStreamerHandler());
  }

  public registerComponent(handler: any): void {
    this.registry.register(handler);
  }

  async connect(): Promise<void> {
    await this.driver.connect();
  }

  async ask(prompt: string, options?: GeminiOptions): Promise<GeminiResponse> {
    const opts = { ...this.defaultOptions, ...options };
    const model = opts.model ?? opts.modelId ?? 'flash';

    const payload: any = { prompt, model, timeoutMs: opts.timeoutMs };
    if (opts.newChat) {
      payload.url = 'https://gemini.google.com/app';
    }

    const res = await this.driver.executeAction<AnswerReplyEnvelope>({
      action: 'inject_and_send',
      payload,
      // The driver honours the *top-level* budget, so a caller's timeoutMs has
      // to ride up here — nesting it inside `payload` left it unread and every
      // ask was silently capped at 60s regardless of what was requested.
      timeoutMs: opts.timeoutMs,
    });

    // Judge the reply on its own evidence, not on one flag a producer may have
    // forgotten to set. This used to require `turnComplete` unconditionally, so
    // a recovered answer whose envelope omitted it — the exact shape a stale
    // extension build sent, and the shape `recover_last_response` still sends —
    // was discarded and reported as an error, throwing away an answer Gemini
    // had already finished and the user had already paid for. See issue #5.
    if (res.success && res.data && isCompletedAnswer(res.data)) {
      return {
        chatId: res.data.chatId || DEFAULT_CHAT_ID,
        text: res.data.text || '',
        images: [],
        partial: res.data.partial === true,
        // Surfaced rather than swallowed: the freeze watchdog and the recovery
        // path both answer with `recovered: true`, and the tool layer renders a
        // banner for it that ask() previously made unreachable.
        recovered: res.data.recovered === true
      };
    }

    const errMsg = res.error || (res.data && res.data.error) || 'Failed to get Gemini response.';
    if (res.late && res.id) {
      // The wait expired but the turn is still running in the page. Remember the
      // id so the finished answer can be collected instead of forcing a re-ask
      // that pays for the same reasoning twice.
      this.abandonedAction = { id: res.id, at: Date.now() };
    }
    // When the extension returned a result carrying neither error nor
    // data.error, every distinct failure used to collapse into the sentence
    // below, which is undiagnosable. Say which shape arrived instead.
    if (errMsg === 'Failed to get Gemini response.' && res.data) {
      throw new Error(`${errMsg} (result had no error field: ${JSON.stringify(res.data).slice(0, 200)})`);
    }
    throw new Error(errMsg);
  }

  /**
   * Recover the answer to a turn whose wait ran out.
   *
   * The work survives being abandoned in two ways: the extension's own reply
   * may have landed after the host stopped waiting (retained by the driver and
   * handed back here), or the answer may already be saved in the conversation
   * even though no reply ever reached the socket (re-read from the page, the
   * same routine the freeze watchdog uses). Either way the caller gets the
   * completed text instead of an error, flagged as `recovered`.
   */
  async collectLastResponse(options?: { actionId?: string; timeoutMs?: number }): Promise<GeminiResponse> {
    const actionId = options?.actionId ?? this.abandonedAction?.id;

    const late = await this.driver.collectLate<AnswerReplyEnvelope>(actionId);

    // Same predicate as the ask path, so a recovered answer is recognised the
    // same way however it was obtained.
    if (late && late.success && late.data && isCompletedAnswer(late.data)) {
      if (this.abandonedAction && (!actionId || actionId === this.abandonedAction.id)) {
        this.abandonedAction = null;
      }
      return {
        chatId: late.data.chatId || DEFAULT_CHAT_ID,
        text: late.data.text,
        images: [],
        recovered: true,
        recoveredFrom: 'late-reply',
        partial: late.data.partial === true
      };
    }

    // Nothing was retained, so ask the page: the conversation may hold a
    // completed answer even though no reply reached the socket. Nothing is
    // re-asked. The driver adds its own grace on top of this budget.
    const budgetMs = options?.timeoutMs ?? 45000;
    const reread = await this.driver.executeAction<AnswerReplyEnvelope>({
      action: 'recover_last_response',
      payload: { timeoutMs: budgetMs },
      timeoutMs: budgetMs
    });

    // The page's own recovery reply omits `turnComplete` on the builds that
    // predate the shared envelope, and it is the only producer that still does,
    // so it is accepted on `recovered` + real text. An empty recovery is not an
    // answer and now reports as "nothing to collect" instead of an empty string
    // dressed up as one.
    if (reread.success && reread.data && isCompletedAnswer(reread.data)) {
      if (this.abandonedAction && (!actionId || actionId === this.abandonedAction.id)) {
        this.abandonedAction = null;
      }
      return {
        chatId: reread.data.chatId || DEFAULT_CHAT_ID,
        text: reread.data.text,
        images: [],
        recovered: true,
        recoveredFrom: 'saved-conversation',
        partial: false
      };
    }

    const why = late?.error || reread.error || reread.data?.error;
    throw new Error(
      'Nothing to collect: no answer was retained for the last timed-out turn and the saved conversation '
      + 'did not yield one' + (why ? ` (${why})` : '') + '.'
    );
  }

  async stream(prompt: string, options?: GeminiOptions): Promise<GeminiResponse> {
    const opts = { ...this.defaultOptions, ...options };
    const model = opts.model ?? opts.modelId ?? 'flash';

    const payload: any = { prompt, model, timeoutMs: opts.timeoutMs };
    if (opts.newChat) {
      payload.url = 'https://gemini.google.com/app';
    }

    let fullText = '';
    let chatId = 'https://gemini.google.com/app';
    let completed = false;

    const actionPromise = this.driver.executeAction<AnswerReplyEnvelope>({
      action: 'inject_and_send',
      payload,
      timeoutMs: opts.timeoutMs,
    });

    return new Promise((resolve, reject) => {
      const finish = (response: GeminiResponse) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        cleanup();
        resolve(response);
      };
      const fail = (error: Error) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        cleanup();
        reject(error);
      };
      // Last resort only. The page spends `timeoutMs` deciding, the driver's
      // action reply gets grace on top of that, and this sits above both — so
      // the informative failure is the one that normally surfaces, and this
      // only fires when the whole bridge has genuinely gone quiet.
      const timeout = setTimeout(() => {
        fail(new Error('Stream timed out waiting for completion.'));
      }, (opts.timeoutMs ?? 60000) + STREAM_GRACE_MS);

      const cleanup = () => {
        this.driver.offEvent('stream_delta', handleDelta);
        this.driver.offEvent('turn_complete', handleComplete);
      };

      const handleDelta = (msg: any) => {
        const delta = typeof msg.delta === 'string' ? msg.delta : '';
        if (!delta) return;
        fullText += delta;
        if (opts.onChunk) opts.onChunk({ delta, accumulatedText: fullText });
      };

      const handleComplete = (msg: any) => {
        const text = typeof msg.text === 'string' && msg.text ? msg.text : fullText;
        if (msg.chatId) chatId = msg.chatId;
        finish({ chatId, text, images: [], recovered: msg.recovered === true, partial: msg.partial === true });
      };

      this.driver.onEvent('stream_delta', handleDelta);
      this.driver.onEvent('turn_complete', handleComplete);

      actionPromise.then((res) => {
        if (!res.success || !res.data?.success) {
          if (res.late && res.id) {
            // Same as ask(): the turn is still running, so keep the id for a
            // later collect rather than treating the answer as lost.
            this.abandonedAction = { id: res.id, at: Date.now() };
          }
          fail(new Error(res.error || res.data?.error || 'Failed to stream Gemini response.'));
          return;
        }
        // The action reply carries the authoritative final text, so it settles
        // the stream on its own. Gating this on `fullText` meant a turn whose
        // deltas were all dropped threw away the complete answer it was
        // holding and then hung until the timeout. `finish` is already
        // idempotent, so losing the race to `handleComplete` is harmless.
        if (res.data?.text) {
          finish({
            chatId: res.data.chatId || chatId,
            text: res.data.text,
            images: [],
            recovered: res.data.recovered === true,
            partial: res.data.partial === true
          });
        }
      }).catch((err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async listHistory(): Promise<{ title: string; url: string }[]> {
    const res = await this.driver.executeAction<{ success: boolean; history?: { title: string; url: string }[]; error?: string }>({
      action: 'read_history'
    });

    if (res.success && res.data && res.data.success) {
      return res.data.history || [];
    }
    const errMsg = res.error || (res.data ? res.data.error : null) || 'Failed to read history from Gemini sidebar.';
    throw new Error(errMsg);
  }

  async selectHistory(target: { title?: string; url?: string }): Promise<{ success: boolean; url?: string }> {
    const res = await this.driver.executeAction<{ success: boolean; url?: string; error?: string }>({
      action: 'select_history',
      payload: target as any
    });

    if (res.success && res.data && res.data.success) {
      return { success: true, url: res.data.url };
    }
    const errMsg = res.error || (res.data ? res.data.error : null) || 'Failed to select conversation from Gemini sidebar.';
    throw new Error(errMsg);
  }

  async captureScreenshot(): Promise<string> {
    const res = await this.driver.executeAction<{ dataUrl: string }>({
      action: 'capture_screenshot'
    });

    if (res.success && res.data) {
      return res.data.dataUrl;
    }
    throw new Error(res.error || 'Failed to capture screenshot from active tab.');
  }

  async dumpDom(selector?: string): Promise<any> {
    const res = await this.driver.executeAction<{ result: any }>({
      action: 'dom_dump',
      payload: { selector } as any
    });

    if (res.success && res.data) {
      // The content script wraps the outline in `result`; a build that replies
      // with the outline itself must not come back as undefined.
      return res.data.result ?? res.data;
    }
    throw new Error(res.error || 'Failed to dump DOM subtree.');
  }

  async getCookies(domain: string): Promise<any[]> {
    const res = await this.driver.executeAction<{ cookies: any[] }>({
      action: 'cookies:get',
      payload: { domain } as any
    });

    if (res.success && res.data) {
      return res.data.cookies;
    }
    throw new Error(res.error || `Failed to read cookies for domain ${domain}.`);
  }

  async restoreCookies(domain: string, cookies: any[]): Promise<void> {
    const res = await this.driver.executeAction<{ ok: boolean }>({
      action: 'cookies:restore',
      payload: { domain, cookies } as any
    });

    if (res.success && res.data && res.data.ok) {
      return;
    }
    throw new Error(res.error || `Failed to restore cookies for domain ${domain}.`);
  }

  async uploadFile(file: { filePath: string }): Promise<void> {
    const res = await this.driver.executeAction<{ success: boolean; error?: string }>({
      action: 'file_upload',
      payload: file as any
    });

    if (res.success && res.data && res.data.success) {
      return;
    }
    throw new Error(res.error || (res.data ? res.data.error : null) || 'Failed to upload file to Gemini.');
  }

  async uploadFiles(files: string[], options?: GeminiOptions): Promise<void> {
    if (!files || files.length === 0) {
      throw new Error('uploadFiles requires a non-empty list of file paths.');
    }
    const opts = { ...this.defaultOptions, ...options };
    const payload: any = { filePaths: files };
    if (opts.newChat) {
      payload.url = 'https://gemini.google.com/app';
    }
    const res = await this.driver.executeAction<{ success: boolean; error?: string }>({
      action: 'file_upload',
      payload,
      // An upload is a wait like any other: without this it silently fell back
      // to the driver's 60s default, the same ceiling this adapter hoists
      // timeoutMs to avoid on the ask path.
      timeoutMs: opts.timeoutMs
    });

    if (res.success && res.data && res.data.success) {
      return;
    }
    throw new Error(res.error || (res.data ? res.data.error : null) || 'Failed to upload files to Gemini.');
  }

  async askWithFiles(query: string, files: string[], options?: GeminiOptions): Promise<GeminiResponse> {
    if (!files || files.length === 0) {
      throw new Error('askWithFiles requires at least one file path.');
    }
    if (!query || !query.trim()) {
      throw new Error('askWithFiles requires a non-empty query string.');
    }

    const opts = { ...this.defaultOptions, ...options };

    // Step 1: Upload files sequentially
    for (const filePath of files) {
      const absolutePath = path.resolve(filePath);
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`File not found: ${absolutePath}`);
      }

      const uploadPayload: any = { filePaths: [absolutePath] };
      if (opts.newChat) {
        uploadPayload.url = 'https://gemini.google.com/app';
      }

      const uploadRes = await this.driver.executeAction<{ success: boolean; error?: string }>({
        action: 'file_upload',
        payload: uploadPayload,
        timeoutMs: opts.timeoutMs
      });

      if (!uploadRes.success || !uploadRes.data?.success) {
        throw new Error(uploadRes.error || (uploadRes.data?.error) || `Failed to upload file: ${absolutePath}`);
      }
    }

    // Step 2: Verify files are attached (check file input)
    const verifyRes = await this.driver.executeAction<{ success: boolean; fileInputs: number; error?: string }>({
      action: 'get_page_info',
      timeoutMs: opts.timeoutMs
    });

    if (!verifyRes.success || verifyRes.data?.fileInputs === 0) {
      throw new Error('File upload verification failed: no file inputs found after upload.');
    }

    // Step 3: Send query with attached files
    return this.ask(query, options);
  }

  async listTabs(): Promise<any[]> {
    const res = await this.driver.executeAction<any>({ action: 'tab_list' });
    if (res.success && res.data && res.data.tabs) return res.data.tabs;
    throw new Error(res.error || 'Failed to list tabs.');
  }

  async createTab(url: string): Promise<any> {
    const res = await this.driver.executeAction<any>({ action: 'tab_create', payload: { url } });
    if (res.success && res.data && res.data.tabId) return res.data;
    throw new Error(res.error || 'Failed to create tab.');
  }

  async closeTab(tabId: number): Promise<void> {
    const res = await this.driver.executeAction<any>({ action: 'tab_close', payload: { tabId } });
    if (!res.success) throw new Error(res.error || 'Failed to close tab.');
  }

  async switchTab(tabId: number): Promise<void> {
    const res = await this.driver.executeAction<any>({ action: 'tab_switch', payload: { tabId } });
    if (!res.success) throw new Error(res.error || 'Failed to switch tab.');
  }

  async listGroups(): Promise<any[]> {
    const res = await this.driver.executeAction<any>({ action: 'tab_group_list' });
    if (res.success && res.data && res.data.groups) return res.data.groups;
    throw new Error(res.error || 'Failed to list groups.');
  }

  async clickButton(selector: string): Promise<any> {
    const res = await this.driver.executeAction<any>({
      action: 'click_button',
      payload: { selector }
    });
    if (res.success && res.data) return res.data;
    throw new Error(res.error || 'Failed to click button.');
  }

  async getPageInfo(): Promise<any> {
    const res = await this.driver.executeAction<any>({ action: 'get_page_info' });
    if (res.success && res.data) return res.data;
    throw new Error(res.error || 'Failed to get page info.');
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}