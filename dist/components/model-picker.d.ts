import { ComponentHandler } from './component.interface.js';
export declare class ModelPickerHandler implements ComponentHandler {
    name: string;
    selectors: string[];
    queryDOM(root?: Document | Element): Element | null;
    execute(args?: Record<string, unknown>): Promise<boolean>;
}
//# sourceMappingURL=model-picker.d.ts.map