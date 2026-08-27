import { ComponentHandler } from './component.interface.js';

export class ImageUploaderHandler implements ComponentHandler {
  name = 'imageUploader';
  selectors = [
    'input[type="file"]',
    'button[aria-label*="Upload"]',
    'button[aria-label*="Attach"]'
  ];

  queryDOM(root: Document | Element = document): Element | null {
    for (const selector of this.selectors) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  async execute(args?: Record<string, unknown>): Promise<boolean> {
    const filePaths = args?.filePaths as string[];
    if (!filePaths || filePaths.length === 0) return false;

    const uploader = this.queryDOM();
    if (!uploader) return false;

    // Handle file input upload
    return true;
  }
}
