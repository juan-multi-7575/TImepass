export class RetryHandler {
  private maxRetries: number;

  constructor(maxRetries = 2) {
    this.maxRetries = maxRetries;
  }

  async executeWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt <= this.maxRetries) {
      try {
        return await fn();
      } catch (err: any) {
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
