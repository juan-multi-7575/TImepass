import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DomService } from './dom-service.js';

interface FakeStyle {
  visibility: string;
  display: string;
  opacity: string;
  cursor: string;
}

const styleMap = new Map<Element, FakeStyle>();

function fakeElement(opts: {
  tag: string;
  width?: number;
  height?: number;
  style?: Partial<FakeStyle>;
  attrs?: Record<string, string>;
}): Element {
  const attrs = opts.attrs ?? {};
  const style: FakeStyle = { visibility: 'visible', display: 'block', opacity: '1', cursor: 'default', ...opts.style };
  const el = {
    tagName: opts.tag.toUpperCase(),
    getBoundingClientRect: () => ({ width: opts.width ?? 10, height: opts.height ?? 10 }),
    getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
    hasAttribute: (name: string) => name in attrs
  } as unknown as Element;
  styleMap.set(el, style);
  return el;
}

beforeEach(() => {
  styleMap.clear();
  vi.stubGlobal('getComputedStyle', (el: Element) => styleMap.get(el)!);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DomService.scoreNode', () => {
  it('marks a pointer-cursor button visible and clickable', () => {
    const el = fakeElement({ tag: 'button', style: { cursor: 'pointer' } });
    expect(DomService.scoreNode(el)).toEqual({ visible: true, clickable: true, clickScore: 0.9 });
  });

  it('rejects visibility:hidden elements', () => {
    const el = fakeElement({ tag: 'button', style: { visibility: 'hidden', cursor: 'pointer' } });
    expect(DomService.scoreNode(el)).toEqual({ visible: false, clickable: false, clickScore: 0 });
  });

  it('rejects aria-disabled elements', () => {
    const el = fakeElement({ tag: 'button', attrs: { 'aria-disabled': 'true' }, style: { cursor: 'pointer' } });
    expect(DomService.scoreNode(el)).toEqual({ visible: true, clickable: false, clickScore: 0 });
  });

  it('rejects fully transparent elements', () => {
    const el = fakeElement({ tag: 'button', style: { opacity: '0', cursor: 'pointer' } });
    expect(DomService.scoreNode(el)).toEqual({ visible: false, clickable: false, clickScore: 0 });
  });
});
