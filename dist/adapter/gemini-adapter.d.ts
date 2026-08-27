import { GeminiOptions, GeminiResponse } from './types.js';
export declare class GeminiAdapter {
    private driver;
    private registry;
    private retryHandler;
    private defaultOptions;
    constructor(options?: GeminiOptions);
    private registerDefaultComponents;
    registerComponent(handler: any): void;
    connect(): Promise<void>;
    ask(prompt: string, options?: GeminiOptions): Promise<GeminiResponse>;
    listHistory(): Promise<{
        title: string;
        url: string;
    }[]>;
    selectHistory(target: {
        title?: string;
        url?: string;
    }): Promise<{
        success: boolean;
        url?: string;
    }>;
    captureScreenshot(): Promise<string>;
    dumpDom(selector?: string): Promise<any>;
    getCookies(domain: string): Promise<any[]>;
    restoreCookies(domain: string, cookies: any[]): Promise<void>;
    uploadFile(file: {
        fileName: string;
        mimeType: string;
        base64Data: string;
    }): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=gemini-adapter.d.ts.map