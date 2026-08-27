import { ExtensionDriver } from '../driver/extension-driver.js';
import { CdpDriver } from '../driver/cdp-driver.js';
import { ComponentRegistry } from '../components/registry.js';
import { PromptInputHandler } from '../components/prompt-input.js';
import { SendButtonHandler } from '../components/send-button.js';
import { ModelPickerHandler } from '../components/model-picker.js';
import { ImageUploaderHandler } from '../components/image-uploader.js';
import { ResponseStreamerHandler } from '../components/response-streamer.js';
import { RetryHandler } from './retry-handler.js';
export class GeminiAdapter {
    driver;
    registry;
    retryHandler;
    defaultOptions;
    constructor(options = {}) {
        this.defaultOptions = {
            driver: 'extension',
            model: 'flash',
            timeoutMs: 60000,
            maxRetries: 2,
            ...options
        };
        if (this.defaultOptions.driver === 'cdp') {
            this.driver = new CdpDriver();
        }
        else {
            this.driver = new ExtensionDriver();
        }
        this.registry = new ComponentRegistry();
        this.registerDefaultComponents();
        this.retryHandler = new RetryHandler(this.defaultOptions.maxRetries);
    }
    registerDefaultComponents() {
        this.registry.register(new PromptInputHandler());
        this.registry.register(new SendButtonHandler());
        this.registry.register(new ModelPickerHandler());
        this.registry.register(new ImageUploaderHandler());
        this.registry.register(new ResponseStreamerHandler());
    }
    registerComponent(handler) {
        this.registry.register(handler);
    }
    async connect() {
        await this.driver.connect();
    }
    async ask(prompt, options) {
        const opts = { ...this.defaultOptions, ...options };
        return new Promise((resolve, reject) => {
            const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            let accumulated = '';
            // Bind streaming & completion listeners
            const deltaListener = (msg) => {
                if (msg.id === id) {
                    accumulated = msg.accumulatedText;
                    if (opts.onChunk) {
                        opts.onChunk({ delta: msg.delta, accumulatedText: accumulated });
                    }
                }
            };
            const completeListener = (msg) => {
                if (msg.id === id) {
                    resolve({
                        chatId: msg.chatId || 'https://gemini.google.com/app',
                        text: msg.text || accumulated,
                        images: msg.images ? msg.images.map((img) => img.src) : []
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
                }
                else {
                    reject(new Error(`Gemini response timed out after ${opts.timeoutMs}ms`));
                }
            }, opts.timeoutMs);
        });
    }
    async listHistory() {
        const res = await this.driver.executeAction({
            action: 'read_history'
        });
        if (res.success && res.data && res.data.success) {
            return res.data.history || [];
        }
        const errMsg = res.error || (res.data ? res.data.error : null) || 'Failed to read history from Gemini sidebar.';
        throw new Error(errMsg);
    }
    async selectHistory(target) {
        const res = await this.driver.executeAction({
            action: 'select_history',
            payload: target
        });
        if (res.success && res.data && res.data.success) {
            return { success: true, url: res.data.url };
        }
        const errMsg = res.error || (res.data ? res.data.error : null) || 'Failed to select conversation from Gemini sidebar.';
        throw new Error(errMsg);
    }
    async captureScreenshot() {
        const res = await this.driver.executeAction({
            action: 'capture_screenshot'
        });
        if (res.success && res.data) {
            return res.data.dataUrl;
        }
        throw new Error(res.error || 'Failed to capture screenshot from active tab.');
    }
    async dumpDom(selector) {
        const res = await this.driver.executeAction({
            action: 'dom_dump',
            payload: { selector }
        });
        if (res.success && res.data) {
            return res.data.result;
        }
        throw new Error(res.error || 'Failed to dump DOM subtree.');
    }
    async getCookies(domain) {
        const res = await this.driver.executeAction({
            action: 'cookies:get',
            payload: { domain }
        });
        if (res.success && res.data) {
            return res.data.cookies;
        }
        throw new Error(res.error || `Failed to read cookies for domain ${domain}.`);
    }
    async restoreCookies(domain, cookies) {
        const res = await this.driver.executeAction({
            action: 'cookies:restore',
            payload: { domain, cookies }
        });
        if (res.success && res.data && res.data.ok) {
            return;
        }
        throw new Error(res.error || `Failed to restore cookies for domain ${domain}.`);
    }
    async uploadFile(file) {
        const res = await this.driver.executeAction({
            action: 'file_upload',
            payload: file
        });
        if (res.success && res.data && res.data.success) {
            return;
        }
        throw new Error(res.error || (res.data ? res.data.error : null) || 'Failed to upload file to Gemini.');
    }
    async close() {
        await this.driver.close();
    }
}
//# sourceMappingURL=gemini-adapter.js.map