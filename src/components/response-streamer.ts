import { ComponentHandler } from './component.interface.js';

export class ResponseStreamerHandler implements ComponentHandler {
  name = 'responseStreamer';
  selectors = [
    'message-content',
    'model-response',
    '.model-response'
  ];

  queryDOM(root: Document | Element = document): Element | null {
    const elements = root.querySelectorAll(this.selectors.join(', '));
    if (elements.length > 0) {
      return elements[elements.length - 1]; // Return latest turn
    }
    return null;
  }

  async execute(): Promise<boolean> {
    return true;
  }
}
