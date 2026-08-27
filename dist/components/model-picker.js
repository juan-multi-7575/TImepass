export class ModelPickerHandler {
    name = 'modelPicker';
    selectors = [
        'button[aria-label*="model"]',
        '.model-picker-button',
        'mat-select[aria-label*="Model"]'
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
        const model = args?.model; // 'flash' | 'pro' | 'thinking'
        if (!model)
            return false;
        const picker = this.queryDOM();
        if (!picker)
            return false;
        picker.click();
        // Wait for dropdown and click requested model option
        return true;
    }
}
//# sourceMappingURL=model-picker.js.map