export class ComponentRegistry {
    handlers = new Map();
    register(handler) {
        if (this.handlers.has(handler.name)) {
            console.warn(`[ComponentRegistry] Overwriting component handler: ${handler.name}`);
        }
        this.handlers.set(handler.name, handler);
    }
    get(name) {
        return this.handlers.get(name);
    }
    has(name) {
        return this.handlers.has(name);
    }
    list() {
        return Array.from(this.handlers.keys());
    }
}
//# sourceMappingURL=registry.js.map