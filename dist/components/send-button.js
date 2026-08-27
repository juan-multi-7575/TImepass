export class SendButtonHandler {
    name = 'sendButton';
    selectors = [
        'button[aria-label*="Send"]',
        'button[aria-label*="Submit"]',
        'div[class*="send-button-container"] button',
        '.send-button'
    ];
    queryDOM(root = document) {
        for (const selector of this.selectors) {
            const el = root.querySelector(selector);
            if (el && !el.disabled)
                return el;
        }
        return null;
    }
    async execute() {
        const el = this.queryDOM();
        if (!el)
            return false;
        el.click();
        return true;
    }
}
//# sourceMappingURL=send-button.js.map