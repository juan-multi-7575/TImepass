export class PromptInputHandler {
    name = 'promptInput';
    selectors = [
        'rich-textarea .ql-editor',
        'rich-textarea [contenteditable="true"]',
        '[aria-label*="Prompt"]',
        'div[role="textbox"]',
        'rich-textarea > div > p',
        'textarea'
    ];
    queryDOM(root = document) {
        for (const selector of this.selectors) {
            const el = root.querySelector(selector);
            if (el)
                return el;
        }
        return null;
    }
    async execute(args) {
        const text = args?.text;
        if (!text)
            return false;
        const el = this.queryDOM();
        if (!el)
            return false;
        el.focus();
        el.innerHTML = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
}
//# sourceMappingURL=prompt-input.js.map