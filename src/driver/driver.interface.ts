export interface ActionPayload {
  id?: string;
  targetComponent?: string;
  action: string;
  payload?: Record<string, unknown>;
  /** Per-action budget in ms. When set, the driver abandons the request at
   * `timeoutMs + ACTION_GRACE_MS` instead of the default 60s, so a caller that
   * asks for two minutes is not capped at one. */
  timeoutMs?: number;
}

export interface ActionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  /** Id of the action this result belongs to. A timed-out action carries it so
   * the caller can still collect the answer if the extension replies later. */
  id?: string;
  /** The host has stopped waiting, but the action is not necessarily lost — the
   * extension may still answer it. That reply is retained for `collectLate`
   * rather than discarded the moment this flag is set. */
  late?: boolean;
}

export interface BrowserDriver {
  connect(): Promise<void>;
  executeAction<T>(payload: ActionPayload): Promise<ActionResult<T>>;
  /**
   * Take the answer to an action the host already abandoned, when the
   * extension replied after the timeout. Returns null when nothing was
   * retained. Without an id, the most recent retained reply is returned.
   */
  collectLate<T = unknown>(id?: string): Promise<ActionResult<T> | null>;
  onEvent(event: string, callback: (data: any) => void): void;
  offEvent(event: string, callback: (data: any) => void): void;
  close(): Promise<void>;
}
