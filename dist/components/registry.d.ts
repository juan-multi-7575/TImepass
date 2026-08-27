import { ComponentHandler } from './component.interface.js';
export declare class ComponentRegistry {
    private handlers;
    register(handler: ComponentHandler): void;
    get(name: string): ComponentHandler | undefined;
    has(name: string): boolean;
    list(): string[];
}
//# sourceMappingURL=registry.d.ts.map