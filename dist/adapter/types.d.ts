export interface GeminiOptions {
    model?: 'flash' | 'pro' | 'thinking';
    chatId?: string;
    newChat?: boolean;
    driver?: 'extension' | 'cdp';
    stealth?: boolean;
    timeoutMs?: number;
    maxRetries?: number;
    onChunk?: (chunk: StreamChunk) => void;
}
export interface StreamChunk {
    delta: string;
    accumulatedText: string;
}
export interface GeminiResponse {
    chatId: string;
    text: string;
    html?: string;
    images?: string[];
}
//# sourceMappingURL=types.d.ts.map