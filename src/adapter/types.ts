export type GeminiModelId = string;

export interface GeminiOptions {
  /** Canonical model identifier. */
  model?: GeminiModelId;
  /** Backward-compatible alias for `model`. Prefer `model` in new code. */
  modelId?: string;
  chatId?: string;
  newChat?: boolean;
  driver?: 'extension' | 'cdp';
  stealth?: boolean;
  timeoutMs?: number;
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
  /**
   * True when the answer was re-read from Gemini's saved conversation after the
   * tab froze and was reloaded, rather than collected from the live stream.
   */
  recovered?: boolean;
  /**
   * True when the wait ran out before the answer finished. `text` then holds
   * only what had rendered by that point, so treat it as a fragment. Absent or
   * false means the turn completed normally.
   *
   * This is not the same as a display bound: `text` here is never deliberately
   * shortened, it is just unfinished.
   */
  partial?: boolean;
}
