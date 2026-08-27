import { ComponentHandler } from './component.interface.js';

export class PromptInputHandler implements ComponentHandler {
  name = 'promptInput';
  selectors = [
    'rich-textarea .ql-editor',
    'rich-textarea [contenteditable="true"]',
    '[aria-label*="Prompt"]',
    'div[role="textbox"]',
    'rich-textarea > div > p',
    'textarea'
  ];

  queryDOM(root: Document | Element = document): Element | null {
    for (const selector of this.selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  async execute(args?: Record<string, unknown>): Promise<boolean> {
    const text = args?.text as string;
    if (!text) return false;

    const el = this.queryDOM();
    if (!el) return false;

    (el as HTMLElement).focus();
    el.innerHTML = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return true;
  }
}
