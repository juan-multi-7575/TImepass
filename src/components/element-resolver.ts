import { RefMap } from './ref-map.js';
import { ResolutionResult } from './component.interface.js';
import { AdaptiveStore } from './adaptive/store.js';

export class ElementResolutionError extends Error {
  kind: 'transient' | 'permanent';

  constructor(message: string, kind: 'transient' | 'permanent') {
    super(message);
    this.name = 'ElementResolutionError';
    this.kind = kind;
  }
}

type TargetKind = 'ref' | 'css' | 'text' | 'label';

interface ParsedTarget {
  kind: TargetKind;
  value: string;
  index?: number;
}

function parseRef(input: string): number | null {
  const t = String(input ?? '').trim();
  if (t.startsWith('@') && /^\d+$/.test(t.slice(1))) return Number(t.slice(1));
  if (t.startsWith('ref=') && /^\d+$/.test(t.slice(4))) return Number(t.slice(4));
  return null;
}

export class ElementResolver {
  private adaptive: AdaptiveStore | null;

  constructor(private refMap: RefMap, adaptive?: AdaptiveStore) {
    this.adaptive = adaptive ?? null;
  }

  parseTarget(target: string): ParsedTarget {
    const t = String(target ?? '').trim();
    const ref = parseRef(t);
    if (ref !== null) return { kind: 'ref', value: t, index: ref };
    if (t.startsWith('loc=css:')) return { kind: 'css', value: t.slice(8).trim() };
    if (t.startsWith('css:')) return { kind: 'css', value: t.slice(4).trim() };
    if (t.startsWith('text:')) return { kind: 'text', value: t.slice(5).trim() };
    if (t.startsWith('label:')) return { kind: 'label', value: t.slice(6).trim() };
    return { kind: 'css', value: t };
  }

  resolveFromSelectors(selectors: string[]): Element | null {
    for (const selector of selectors) {
      let el: Element | null = null;
      try {
        el = document.querySelector(selector);
      } catch {
        continue;
      }
      if (el && el.getClientRects().length) return el;
    }
    return null;
  }

  resolveElement(target: string): ResolutionResult {
    const parsed = this.parseTarget(target);
    if (parsed.kind === 'ref') return this.resolveRef(parsed);
    if (parsed.kind === 'css') return this.resolveCss(parsed.value);
    if (parsed.kind === 'text') return this.resolveText(parsed.value);
    return this.resolveLabel(parsed.value);
  }

  resolveCenter(target: string): { x: number; y: number } {
    const { element } = this.resolveElement(target);
    const rect = element.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      throw new ElementResolutionError('Element has no box model (not rendered or zero-sized)', 'transient');
    }
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  private resolveRef(parsed: ParsedTarget): ResolutionResult {
    const el = this.refMap.resolve(parsed.index as number);
    if (el) {
      if (el.isConnected) return { element: el, source: 'ref', confidence: 1 };
      const ax = this.findByAccessibility(el);
      if (ax) return { element: ax, source: 'adaptive', confidence: 0.5 };
      const adaptive = this.tryAdaptive(parsed.value);
      if (adaptive) return adaptive;
      throw new ElementResolutionError(`Ref ${parsed.value} is stale`, 'transient');
    }
    const adaptive = this.tryAdaptive(parsed.value);
    if (adaptive) return adaptive;
    throw new ElementResolutionError(`Unknown ref: ${parsed.value}`, 'transient');
  }

  private resolveCss(selector: string): ResolutionResult {
    let el: Element | null = null;
    try {
      el = document.querySelector(selector);
    } catch {
      throw new ElementResolutionError(`Invalid selector: ${selector}`, 'permanent');
    }
    if (el) return { element: el, source: 'selector', confidence: 1 };
    const adaptive = this.tryAdaptive(selector);
    if (adaptive) return adaptive;
    throw new ElementResolutionError(`Not found: ${selector}`, 'transient');
  }

  private resolveText(text: string): ResolutionResult {
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const content = ((el as HTMLElement).innerText || el.textContent || '').trim();
      if (content === text) return { element: el, source: 'selector', confidence: 1 };
    }
    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (((el as HTMLElement).innerText || el.textContent || '').includes(text)) {
        return { element: el, source: 'selector', confidence: 0.8 };
      }
    }
    const adaptive = this.tryAdaptive(text);
    if (adaptive) return adaptive;
    throw new ElementResolutionError(`Text not found: ${text}`, 'transient');
  }

  private resolveLabel(label: string): ResolutionResult {
    for (const el of Array.from(document.querySelectorAll('[aria-label]'))) {
      if (el.getAttribute('aria-label') === label) return { element: el, source: 'selector', confidence: 1 };
    }
    for (const labelEl of Array.from(document.querySelectorAll('label'))) {
      if ((labelEl.textContent || '').trim() !== label) continue;
      const forId = (labelEl as HTMLLabelElement).htmlFor;
      if (forId) {
        const control = document.getElementById(forId);
        if (control) return { element: control, source: 'selector', confidence: 0.9 };
      }
      const control = labelEl.querySelector('input, textarea, select, button');
      if (control) return { element: control, source: 'selector', confidence: 0.9 };
    }
    const adaptive = this.tryAdaptive(label);
    if (adaptive) return adaptive;
    throw new ElementResolutionError(`Label not found: ${label}`, 'transient');
  }

  private tryAdaptive(identifier: string): ResolutionResult | null {
    if (!this.adaptive) return null;
    const fingerprint = this.adaptive.retrieve(identifier);
    if (!fingerprint) return null;
    const el = this.adaptive.relocate(fingerprint, document.body);
    if (!el) return null;
    return { element: el, source: 'adaptive', confidence: 0.6 };
  }

  private findByAccessibility(el: Element): Element | null {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    for (const node of Array.from(document.querySelectorAll('*'))) {
      if (node === el) continue;
      if (node.tagName.toLowerCase() !== tag) continue;
      if (role && node.getAttribute('role') !== role) continue;
      if (ariaLabel && node.getAttribute('aria-label') !== ariaLabel) continue;
      if (node.getClientRects().length) return node;
    }
    return null;
  }
}
