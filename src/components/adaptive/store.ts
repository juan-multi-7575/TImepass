import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Fingerprint {
  tag: string;
  cleanedAttributes: Record<string, string>;
  text: string | null;
  tagPath: string[];
  parent: { tag: string; cleanedAttributes: Record<string, string>; text: string | null } | null;
  siblings: string[];
  children: string[];
}

function cleanAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (let i = 0; i < el.attributes.length; i++) {
    const value = el.attributes[i].value.trim();
    if (value) attrs[el.attributes[i].name] = value;
  }
  return attrs;
}

function textOf(el: Element): string | null {
  const t = ((el as HTMLElement).innerText || el.textContent || '').trim();
  return t.length ? t : null;
}

function rootOf(el: Element): Element {
  return (el.ownerDocument && el.ownerDocument.documentElement) || el;
}

export function elementToDict(element: Element, root?: Element): Fingerprint {
  const r = root ?? rootOf(element);
  const chain: string[] = [];
  let cur: Element | null = element;
  while (cur && cur !== r) {
    chain.push(cur.tagName.toLowerCase());
    cur = cur.parentElement;
  }
  if (cur === r) chain.push(r.tagName.toLowerCase());
  chain.reverse();

  const parentEl = element.parentElement;
  let parent: Fingerprint['parent'] = null;
  if (parentEl) {
    parent = {
      tag: parentEl.tagName.toLowerCase(),
      cleanedAttributes: cleanAttributes(parentEl),
      text: textOf(parentEl),
    };
  }

  const siblings: string[] = [];
  if (parentEl) {
    for (let i = 0; i < parentEl.children.length; i++) {
      if (parentEl.children[i] !== element) siblings.push(parentEl.children[i].tagName.toLowerCase());
    }
  }

  const children: string[] = [];
  for (let i = 0; i < element.children.length; i++) {
    children.push(element.children[i].tagName.toLowerCase());
  }

  return {
    tag: element.tagName.toLowerCase(),
    cleanedAttributes: cleanAttributes(element),
    text: textOf(element),
    tagPath: chain,
    parent,
    siblings,
    children,
  };
}

function sequenceRatio(a: unknown, b: unknown): number {
  const A = Array.isArray(a) ? a.map(String) : a == null ? [] : Array.from(String(a));
  const B = Array.isArray(b) ? b.map(String) : b == null ? [] : Array.from(String(b));
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;
  if (A.length * B.length > 40000) {
    const freq = new Map<string, number>();
    for (const token of A) freq.set(token, (freq.get(token) ?? 0) + 1);
    let common = 0;
    for (const token of B) {
      const count = freq.get(token);
      if (count) {
        common++;
        freq.set(token, count - 1);
      }
    }
    return (2 * common) / (A.length + B.length);
  }
  const dp = new Array<number>(B.length + 1).fill(0);
  for (let i = 0; i < A.length; i++) {
    let prev = 0;
    for (let j = 0; j < B.length; j++) {
      const temp = dp[j + 1];
      dp[j + 1] = A[i] === B[j] ? prev + 1 : Math.max(dp[j], dp[j + 1]);
      prev = temp;
    }
  }
  return (2 * dp[B.length]) / (A.length + B.length);
}

function dictRatio(d1: Record<string, string>, d2: Record<string, string>): number {
  const k1 = Object.keys(d1);
  const k2 = Object.keys(d2);
  return sequenceRatio(k1, k2) * 0.5 + sequenceRatio(k1.map((k) => d1[k]), k2.map((k) => d2[k])) * 0.5;
}

function similarityScore(original: Fingerprint, node: Element, root: Element): number {
  const data = elementToDict(node, root);
  let score = 0;
  let checks = 0;
  score += original.tag === data.tag ? 1 : 0;
  checks++;
  if (original.text) {
    score += sequenceRatio(original.text, data.text ?? '');
    checks++;
  }
  score += dictRatio(original.cleanedAttributes, data.cleanedAttributes);
  checks++;
  for (const attrib of ['class', 'id', 'href', 'src']) {
    const value = original.cleanedAttributes[attrib];
    if (value) {
      score += sequenceRatio(value, data.cleanedAttributes[attrib] ?? '');
      checks++;
    }
  }
  score += sequenceRatio(original.tagPath, data.tagPath);
  checks++;
  if (original.parent) {
    if (data.parent) {
      score += sequenceRatio(original.parent.tag, data.parent.tag);
      checks++;
      score += dictRatio(original.parent.cleanedAttributes, data.parent.cleanedAttributes);
      checks++;
      if (original.parent.text) {
        score += sequenceRatio(original.parent.text, data.parent.text ?? '');
        checks++;
      }
    }
  }
  if (original.siblings.length) {
    score += sequenceRatio(original.siblings, data.siblings);
    checks++;
  }
  return checks ? score / checks : 0;
}

function ancestorCount(el: Element, root: Element): number {
  let count = 0;
  let cur: Element | null = el.parentElement;
  while (cur && cur !== root) {
    count++;
    cur = cur.parentElement;
  }
  return count;
}

function areAlike(a: Element, b: Element, threshold: number): boolean {
  const ignore = new Set(['href', 'src']);
  const attrsA: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanAttributes(a))) {
    if (!ignore.has(k)) attrsA[k] = v;
  }
  const attrsB: Record<string, string> = {};
  for (const [k, v] of Object.entries(cleanAttributes(b))) {
    if (!ignore.has(k)) attrsB[k] = v;
  }
  if (Object.keys(attrsA).length === 0) return Object.keys(attrsB).length === 0;
  let score = 0;
  for (const k of Object.keys(attrsA)) score += sequenceRatio(attrsA[k], attrsB[k] ?? '');
  const checks = Math.max(Object.keys(attrsA).length, Object.keys(attrsB).length);
  return checks > 0 && score / checks >= threshold;
}

export class AdaptiveStore {
  private data: Record<string, Record<string, Fingerprint>> = {};
  private file: string;

  constructor(storageFile: string, private domain = '') {
    this.file = storageFile;
    try {
      this.data = JSON.parse(fs.readFileSync(storageFile, 'utf8')) as Record<string, Record<string, Fingerprint>>;
    } catch {
      this.data = {};
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
    } catch {}
  }

  save(identifier: string, element: Element): void {
    if (!this.data[this.domain]) this.data[this.domain] = {};
    this.data[this.domain][identifier] = elementToDict(element);
    this.persist();
  }

  retrieve(identifier: string): Fingerprint | null {
    const bucket = this.data[this.domain];
    return bucket ? (bucket[identifier] ?? null) : null;
  }

  relocate(fingerprint: Fingerprint, root: Element, threshold = 0.6): Element | null {
    const nodes: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
    let best: Element | null = null;
    let bestScore = -1;
    for (const node of nodes) {
      const score = similarityScore(fingerprint, node, root);
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    }
    return bestScore >= threshold ? best : null;
  }

  findSimilar(element: Element, root: Element, threshold = 0.2): Element[] {
    const parts: string[] = [];
    let cur: Element | null = element;
    while (cur && cur !== root && parts.length < 3) {
      parts.unshift(cur.tagName.toLowerCase());
      cur = cur.parentElement;
    }
    if (parts.length === 0) return [];
    const chainSelector = parts.join(' ');
    const targetDepth = ancestorCount(element, root);
    const result: Element[] = [];
    for (const candidate of Array.from(root.querySelectorAll(chainSelector))) {
      if (candidate === element) continue;
      if (ancestorCount(candidate, root) !== targetDepth) continue;
      if (areAlike(element, candidate, threshold)) result.push(candidate);
    }
    return result;
  }
}
