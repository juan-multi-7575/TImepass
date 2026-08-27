import { ComponentHandler } from './component.interface.js';

export class SendButtonHandler implements ComponentHandler {
  name = 'sendButton';
  selectors = [
    'button[aria-label*="Send"]',
    'button[aria-label*="Submit"]',
    'div[class*="send-button-container"] button',
    '.send-button'
  ];

  queryDOM(root: Document | Element = document): Element | null {
    for (const selector of this.selectors) {
      const el = root.querySelector(selector);
      if (el && !(el as HTMLButtonElement).disabled) return el;
    }
    return null;
  }

  async execute(): Promise<boolean> {
    const el = this.queryDOM() as HTMLButtonElement;
    if (!el) return false;

    el.click();
    return true;
  }
}
