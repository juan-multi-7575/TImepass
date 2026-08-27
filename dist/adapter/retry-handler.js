export class RetryHandler {
    maxRetries;
    constructor(maxRetries = 2) {
        this.maxRetries = maxRetries;
    }
    async executeWithRetry(fn) {
        let attempt = 0;
        let lastError = null;
        while (attempt <= this.maxRetries) {
            try {
                return await fn();
            }
            catch (err) {
                attempt++;
                lastError = err;
                console.warn(`[RetryHandler] Action failed (Attempt ${attempt}/${this.maxRetries + 1}): ${err.message}`);
                if (attempt <= this.maxRetries) {
                    await new Promise((r) => setTimeout(r, 1500));
                }
            }
        }
        throw lastError || new Error('Action failed after maximum retries.');
    }
}
//# sourceMappingURL=retry-handler.js.map