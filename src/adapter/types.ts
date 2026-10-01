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

/**
 * The one shape every producer of a completed answer must send.
 *
 * Three producers exist and each used to hand-roll this envelope: the content
 * script's `inject_and_send` reply, the content script's `recover_last_response`
 * reply, and the freeze watchdog's synthesized reply. They drifted — the
 * watchdog once shipped without `turnComplete`, and an answer recovered through
 * that path was classified as a failure by the adapter, so a completed answer
 * Gemini had already paid for was thrown away and reported as an error. See
 * issue #5.
 *
 * `turnComplete` is required on purpose: a producer that omits it is a compile
 * error, not a runtime loss. The host cannot typecheck the extension (it is
 * plain JS), so the wire stays tolerant too — see {@link isCompletedAnswer},
 * which accepts the legacy shape so an old build in a browser still returns its
 * answer instead of failing.
 */
export interface CompletedAnswerEnvelope {
  /** The producer's own success flag, distinct from the transport's. */
  success: true;
  /** The turn finished. Required on every completed answer. */
  turnComplete: true;
  /** The answer itself. May be empty when Gemini returned no text at all. */
  text: string;
  chatId?: string;
  partial?: boolean;
  /** True when the answer was re-read rather than taken from the live stream. */
  recovered?: boolean;
}

/**
 * What a build predating {@link CompletedAnswerEnvelope} actually sends for a
 * recovered answer: the same payload, minus `turnComplete`.
 *
 * Only ever produced by an older extension. Kept as a named shape so the
 * tolerance in {@link isCompletedAnswer} is deliberate and visible rather than
 * an accident of property access.
 */
export interface LegacyRecoveredEnvelope {
  success: true;
  recovered: true;
  text: string;
  chatId?: string;
  partial?: boolean;
}

/** Either form a completed answer may arrive in. */
export type AnswerEnvelope = CompletedAnswerEnvelope | LegacyRecoveredEnvelope;

/**
 * A reply as it arrives, before anything is known about which kind it is.
 *
 * Every field is optional because the extension is plain JavaScript: the wire is
 * untyped at runtime, so the shapes above are a contract this side enforces,
 * not something `tsc` can check end to end.
 */
export interface AnswerReplyEnvelope {
  success?: boolean;
  turnComplete?: boolean;
  recovered?: boolean;
  text?: string;
  chatId?: string;
  partial?: boolean;
  error?: string;
}

/**
 * Decide whether a reply carries a completed answer, on its evidence.
 *
 * The canonical form says so with `turnComplete: true`. A recovered envelope
 * from a build that predates the shared type omits that flag, but it is still a
 * finished answer: the recovery routine only returns once the saved text has
 * settled, so it is accepted on the strength of `recovered` plus non-empty text
 * rather than thrown away. Before this existed the adapter required
 * `turnComplete` unconditionally, so one omitted field silently converted a
 * correct answer into an error.
 *
 * A reply with `turnComplete: false` and no `recovered` flag is still a turn in
 * flight and is deliberately rejected — silence about completion is not
 * completion.
 *
 * @param value - A reply payload of unknown shape.
 * @returns Whether it is a completed answer.
 */
export function isCompletedAnswer(value: unknown): value is AnswerEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true) return false;
  if (envelope.turnComplete === true) return true;
  return envelope.recovered === true && typeof envelope.text === 'string' && envelope.text.length > 0;
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
