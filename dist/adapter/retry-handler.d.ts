export declare class RetryHandler {
    private maxRetries;
    constructor(maxRetries?: number);
    executeWithRetry<T>(fn: () => Promise<T>): Promise<T>;
}
//# sourceMappingURL=retry-handler.d.ts.map