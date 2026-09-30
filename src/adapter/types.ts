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
   *
   * Also true for a turn whose wait timed out and whose answer was collected
   * afterwards — either from the extension's late reply or by re-reading the
   * saved conversation. The text may therefore have been assembled across two
   * calls rather than during one.
   */
  recovered?: boolean;
  /**
   * Where a recovered answer came from, when `recovered` is true. `late-reply`
   * is the extension's own reply landing after the host stopped waiting;
   * `saved-conversation` is a re-read of what Gemini had already saved.
   */
  recoveredFrom?: 'late-reply' | 'saved-conversation';
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
