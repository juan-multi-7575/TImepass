import { BrowserDriver, ActionPayload, ActionResult } from './driver.interface.js';
export declare class ExtensionDriver implements BrowserDriver {
    private wss;
    private clientSocket;
    private pendingRequests;
    private eventListeners;
    private port;
    constructor(port?: number);
    connect(): Promise<void>;
    executeAction<T>(payload: ActionPayload): Promise<ActionResult<T>>;
    onEvent(event: string, callback: (data: any) => void): void;
    close(): Promise<void>;
}
//# sourceMappingURL=extension-driver.d.ts.map