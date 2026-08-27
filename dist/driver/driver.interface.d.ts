export interface ActionPayload {
    id?: string;
    targetComponent?: string;
    action: string;
    payload?: Record<string, unknown>;
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
    close(): Promise<void>;
}
//# sourceMappingURL=driver.interface.d.ts.map