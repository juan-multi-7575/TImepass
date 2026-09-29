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
}

export interface BrowserDriver {
  connect(): Promise<void>;
  executeAction<T>(payload: ActionPayload): Promise<ActionResult<T>>;
  onEvent(event: string, callback: (data: any) => void): void;
  offEvent(event: string, callback: (data: any) => void): void;
  close(): Promise<void>;
}
