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

  static readonly ALIASES: Record<string, string> = {
    flash: '2.5 Flash',
    pro: '2.5 Pro',
    thinking: '2.5 Pro',
    'flash-lite': '2.5 Flash-Lite',
    'gemini-2.5-flash': '2.5 Flash',
    'gemini-2.5-pro': '2.5 Pro',
    'gemini-2.0-flash': '2.0 Flash',
    'gemini-flash-latest': '2.5 Flash'
  };

  async execute(args?: Record<string, unknown>): Promise<boolean> {
    const raw = (args?.model as string) || (args?.modelId as string);
    if (!raw) return false;
    const target = ModelPickerHandler.ALIASES[raw.toLowerCase()] || raw;
    const picker = this.queryDOM() as HTMLElement;
    if (!picker) return false;
    picker.click();
    await new Promise(r => setTimeout(r, 600));
    const opts = document.querySelectorAll('[role="option"], [role="menuitem"], mat-option, button');
    for (const o of Array.from(opts)) {
      const t = (o.textContent || '').trim();
      if (t.toLowerCase().includes(target.toLowerCase()) || target.toLowerCase().includes(t.toLowerCase())) {
        (o as HTMLElement).click();
        return true;
      }
    }
    return false;
  }
}
