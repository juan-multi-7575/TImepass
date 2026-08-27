import { ComponentHandler } from './component.interface.js';
export declare class PromptInputHandler implements ComponentHandler {
    name: string;
    selectors: string[];
    queryDOM(root?: Document | Element): Element | null;
    execute(args?: Record<string, unknown>): Promise<boolean>;
}
//# sourceMappingURL=prompt-input.d.ts.map