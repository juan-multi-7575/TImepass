import { ComponentHandler } from './component.interface.js';
export declare class ResponseStreamerHandler implements ComponentHandler {
    name: string;
    selectors: string[];
    queryDOM(root?: Document | Element): Element | null;
    execute(): Promise<boolean>;
}
//# sourceMappingURL=response-streamer.d.ts.map