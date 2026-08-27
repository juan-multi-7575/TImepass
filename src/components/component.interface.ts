export interface ComponentHandler {
  name: string;
  selectors: string[];
  queryDOM(root?: Document | Element): Element | null;
  execute(args?: Record<string, unknown>): Promise<boolean>;
}
