export class RefMap {
  private elements = new Map<number, Element>();

  assign(map: Map<number, Element>): void {
    this.elements = new Map(map);
  }

  resolve(index: number): Element | null {
    return this.elements.get(index) ?? null;
  }

  resolveCenter(index: number): { x: number; y: number } | null {
    const el = this.resolve(index);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  invalidate(): void {
    this.elements.clear();
  }
}
