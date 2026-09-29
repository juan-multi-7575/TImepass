export interface ScoredNode {
  tag: string;
  id: string;
  cls: string;
  text: string;
  textLen: number;
  rect: { x: number; y: number; w: number; h: number } | null;
  visible: boolean;
  clickable: boolean;
  clickScore: number;
  aria: string;
}

export interface DomStats {
  total: number;
  visible: number;
  clickable: number;
  buttons: number;
}

const CLICKABLE_CANDIDATE_SELECTOR =
  'button, [role="button"], a[href], input, select, textarea, [contenteditable="true"], [onclick], mat-icon-button, gem-icon-button';

export class DomService {
  static scoreNode(node: Element): { visible: boolean; clickable: boolean; clickScore: number } {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      parseFloat(style.opacity) > 0.05;
    const tag = node.tagName.toLowerCase();
    const tagSet = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea';
    const clickable =
      visible &&
      node.getAttribute('aria-disabled') !== 'true' &&
      (style.cursor === 'pointer' ||
        tagSet ||
        node.getAttribute('role') === 'button' ||
        node.hasAttribute('onclick') ||
        node.getAttribute('contenteditable') === 'true');
    const clickScore = clickable
      ? Math.min(
          10,
          4 +
            (style.cursor === 'pointer' ? 3 : 0) +
            (tagSet ? 2 : 0) +
            (node.getAttribute('role') === 'button' ? 1 : 0) +
            (node.hasAttribute('onclick') ? 1 : 0)
        ) / 10
      : 0;
    return { visible, clickable, clickScore };
  }

  static scoreSnapshot(nodes: ScoredNode[]): DomStats {
    return {
      total: nodes.length,
      visible: nodes.filter((n) => n.visible).length,
      clickable: nodes.filter((n) => n.clickable).length,
      buttons: nodes.filter((n) => n.tag === 'button').length
    };
  }
}
