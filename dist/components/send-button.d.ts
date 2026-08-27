import { ComponentHandler } from './component.interface.js';
export declare class SendButtonHandler implements ComponentHandler {
    name: string;
    selectors: string[];
    queryDOM(root?: Document | Element): Element | null;
    execute(): Promise<boolean>;
}
//# sourceMappingURL=send-button.d.ts.map