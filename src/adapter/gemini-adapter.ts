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

    return new Promise<GeminiResponse>((resolve, reject) => {
      const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let accumulated = '';

      // Bind streaming & completion listeners
      const deltaListener = (msg: any) => {
        if (msg.id === id) {
          accumulated = msg.accumulatedText;
          if (opts.onChunk) {
            opts.onChunk({ delta: msg.delta, accumulatedText: accumulated });
          }
        }
      };

      const completeListener = (msg: any) => {
        if (msg.id === id) {
          resolve({
            chatId: msg.chatId || 'https://gemini.google.com/app',
            text: msg.text || accumulated,
            images: msg.images ? msg.images.map((img: any) => img.src) : []
          });
        }
      };

      this.driver.onEvent('stream_delta', deltaListener);
      this.driver.onEvent('turn_complete', completeListener);

      // Execute inject and send action
      this.driver.executeAction({
        id,
        action: 'inject_and_send',
        payload: { prompt, model: opts.model }
      }).then((res) => {
        if (!res.success) {
          reject(new Error(res.error || 'Failed to dispatch prompt to extension.'));
        }
      }).catch(reject);

      // Timeout handler
      setTimeout(() => {
        if (accumulated.length > 0) {
          resolve({ chatId: 'https://gemini.google.com/app', text: accumulated });
        } else {
          reject(new Error(`Gemini response timed out after ${opts.timeoutMs}ms`));
        }
      }, opts.timeoutMs);
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