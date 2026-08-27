import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { BrowserDriver } from '../driver/driver.interface.js';
import { ExtensionDriver } from '../driver/extension-driver.js';
import { CdpDriver } from '../driver/cdp-driver.js';
import { ComponentRegistry } from '../components/registry.js';
import { PromptInputHandler } from '../components/prompt-input.js';
import { SendButtonHandler } from '../components/send-button.js';
import { ModelPickerHandler } from '../components/model-picker.js';
import { ImageUploaderHandler } from '../components/image-uploader.js';
import { ResponseStreamerHandler } from '../components/response-streamer.js';
import { RetryHandler } from './retry-handler.js';
import { GeminiOptions, GeminiResponse, StreamChunk } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class GeminiAdapter {
  private driver: BrowserDriver;
  private registry: ComponentRegistry;
  private retryHandler: RetryHandler;
  private defaultOptions: GeminiOptions;

  constructor(options: GeminiOptions = {}) {
    this.defaultOptions = {
      driver: 'extension',
      model: 'flash',
      timeoutMs: 60000,
      maxRetries: 2,
      ...options
    };

    if (this.defaultOptions.driver === 'cdp') {
      this.driver = new CdpDriver();
    } else {
      this.driver = new ExtensionDriver();
    }

    this.registry = new ComponentRegistry();
    this.registerDefaultComponents();
    this.retryHandler = new RetryHandler(this.defaultOptions.maxRetries);
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

    const payload: any = { prompt, model: opts.model, timeoutMs: opts.timeoutMs };
    if (opts.newChat) {
      payload.url = 'https://gemini.google.com/app';
    }

    const res = await this.driver.executeAction<{
      success: boolean;
      turnComplete: boolean;
      text?: string;
      chatId?: string;
      error?: string;
    }>({
      action: 'inject_and_send',
      payload
    });

    if (res.success && res.data && res.data.success && res.data.turnComplete) {
      return {
        chatId: res.data.chatId || 'https://gemini.google.com/app',
        text: res.data.text || '',
        images: []
      };
    }

    const errMsg = res.error || (res.data && res.data.error) || 'Failed to get Gemini response.';
    throw new Error(errMsg);
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
      return res.data.result;
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
      payload
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
        payload: uploadPayload
      });

      if (!uploadRes.success || !uploadRes.data?.success) {
        throw new Error(uploadRes.error || (uploadRes.data?.error) || `Failed to upload file: ${absolutePath}`);
      }
    }

    // Step 2: Verify files are attached (check file input)
    const verifyRes = await this.driver.executeAction<{ success: boolean; fileInputs: number; error?: string }>({
      action: 'get_page_info'
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