import { ComponentHandler } from './component.interface.js';

export class ModelPickerHandler implements ComponentHandler {
  name = 'modelPicker';
  selectors = [
    'button[aria-label*="model"]',
    '.model-picker-button',
    'mat-select[aria-label*="Model"]'
  ];

  queryDOM(root: Document | Element = document): Element | null {
    for (const selector of this.selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  async execute(args?: Record<string, unknown>): Promise<boolean> {
    const model = args?.model as string; // 'flash' | 'pro' | 'thinking'
    if (!model) return false;

    const picker = this.queryDOM() as HTMLElement;
    if (!picker) return false;

    picker.click();
    // Wait for dropdown and click requested model option
    return true;
  }
}
