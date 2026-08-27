import { ComponentHandler } from './component.interface.js';

export class ComponentRegistry {
  private handlers = new Map<string, ComponentHandler>();

  register(handler: ComponentHandler): void {
    if (this.handlers.has(handler.name)) {
      console.warn(`[ComponentRegistry] Overwriting component handler: ${handler.name}`);
    }
    this.handlers.set(handler.name, handler);
  }

  get(name: string): ComponentHandler | undefined {
    return this.handlers.get(name);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  list(): string[] {
    return Array.from(this.handlers.keys());
  }
}
