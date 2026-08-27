import { BrowserDriver, ActionPayload, ActionResult } from './driver.interface.js';
export declare class CdpDriver implements BrowserDriver {
    private cdpUrl;
    constructor(cdpUrl?: string);
    connect(): Promise<void>;
    executeAction<T>(payload: ActionPayload): Promise<ActionResult<T>>;
    onEvent(event: string, callback: (data: any) => void): void;
    close(): Promise<void>;
}
//# sourceMappingURL=cdp-driver.d.ts.map