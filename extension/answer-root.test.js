import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The shipped answer-root.js is a classic browser script, so it is evaluated
 * here rather than imported. The file only defines a global and performs no
 * DOM work at load time, so a bare global object is enough to host it.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, 'answer-root.js'), 'utf8');

let api;

beforeAll(() => {
  const scope = {};
  new Function('globalThis', SOURCE)(scope);
  api = scope.__timepassAnswer;
});

/**
 * Minimal element stand-in: the helper only uses parentElement, contains,
 * textContent and offsetParent.
 */
function el({ text = '', visible = true, children = [] } = {}) {
  const node = {
    textContent: text,
    offsetParent: visible ? {} : null,
    parentElement: null,
    children,
  };
  // Real DOM `contains` is a descendant test, not a direct-child test.
  node.contains = other => {
    for (let cur = other; cur; cur = cur.parentElement) {
      if (cur === node) return true;
    }
    return false;
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function button(ariaLabel, visible = true) {
  const node = el({ text: '', visible });
  node.ariaLabel = ariaLabel;
  return node;
}

/** Document stub whose selectors return fixed node lists. */
function doc({ containers = [], copies = [] } = {}) {
  return {
    querySelectorAll: selector => {
      if (selector === 'response-container') return containers;
      if (selector.indexOf('button[aria-label') === 0) return copies;
      return [];
    },
  };
}

describe('findAnswerRoot', () => {
  it('prefers the last response-container, which holds the full turn', () => {
    const first = el({ text: 'older turn' });
    const last = el({ text: 'this turn' });
    expect(api.findAnswerRoot(doc({ containers: [first, last] }))).toBe(last);
  });

  it('returns the ancestor holding every chunk, not the biggest chunk', () => {
    // The shape that produced the bug: one long answer split into chunks,
    // each with its own copy button nested inside that chunk.
    const copies = [];
    const chunks = ['Part one. ', 'Part two. ', 'Part three.'].map(text => {
      const copy = button('Copy');
      copies.push(copy);
      return el({ text, children: [copy] });
    });
    const wrapper = el({ text: 'Part one. Part two. Part three.', children: chunks });

    const root = api.findAnswerRoot(doc({ copies }));
    expect(root).toBe(wrapper);
    expect(api.readAnswerText(root)).toBe('Part one. Part two. Part three.');
  });

  it('ignores hidden copy buttons when choosing the ancestor', () => {
    // A hidden stale control must not drag the selection up to the whole page.
    const shownCopy = button('Copy');
    const shownChunk = el({ text: 'fresh answer', children: [shownCopy] });
    const wrapper = el({ text: 'fresh answer', children: [shownChunk] });
    const staleCopy = button('Copy', false);
    const staleChunk = el({ text: 'stale answer', children: [staleCopy] });
    const page = el({ text: 'page', children: [wrapper, staleChunk] });

    const root = api.findAnswerRoot(doc({ copies: [shownCopy, staleCopy] }));
    // Exactly one visible chunk, so the smallest element containing it is that
    // chunk — and crucially not `page`, which is what including the hidden
    // stale copy would have produced.
    expect(root).toBe(shownChunk);
    expect(root).not.toBe(page);
  });

  it('returns null when nothing identifies an answer', () => {
    expect(api.findAnswerRoot(doc({}))).toBeNull();
  });

  it('tolerates a missing document instead of throwing', () => {
    expect(api.findAnswerRoot(null)).toBeNull();
  });
});

describe('readAnswerText', () => {
  it('returns the complete text, not a 200-character slice', () => {
    const long = 'x'.repeat(20000);
    expect(api.readAnswerText(el({ text: long }))).toBe(long);
  });

  it('strips the "Gemini said" header', () => {
    expect(api.readAnswerText(el({ text: 'Gemini said  hello' }))).toBe('hello');
  });

  it('returns an empty string for a missing root', () => {
    expect(api.readAnswerText(null)).toBe('');
  });
});

describe('timeoutOutcome', () => {
  it('labels every result as partial, so a fragment cannot pass for a finished answer', () => {
    const outcome = api.timeoutOutcome([{ source: 'extracted', text: 'half an ans' }]);
    expect(outcome).toEqual({ text: 'half an ans', partial: true, source: 'extracted' });
  });

  it('falls through an unusable source to the next one', () => {
    // The first source is present but too short to be an answer; the second
    // still has the fragment worth returning.
    const outcome = api.timeoutOutcome([
      { source: 'extracted', text: 'ok', minLength: 10 },
      { source: 'response-container', text: 'a longer partial answer' }
    ]);
    expect(outcome).toEqual({ text: 'a longer partial answer', partial: true, source: 'response-container' });
  });

  it('returns null when no source holds a usable fragment', () => {
    expect(api.timeoutOutcome([
      { source: 'extracted', text: '', minLength: 10 },
      { source: 'extracted', text: '   ', minLength: 10 },
      { source: 'response-container', text: '' }
    ])).toBeNull();
  });

  it('tolerates missing and null candidates', () => {
    expect(api.timeoutOutcome([null, { source: 'extracted' }, undefined])).toBeNull();
    expect(api.timeoutOutcome(null)).toBeNull();
  });

  it('trims surrounding whitespace off the fragment', () => {
    expect(api.timeoutOutcome([{ source: 'extracted', text: '\n  partial  \n' }]).text).toBe('partial');
  });
});

describe('resumeTypingIndex', () => {
  it('restarts when the replacement editor came up empty', () => {
    // The keystrokes went down with the detached node, so continuing would
    // leave the prompt missing its opening words.
    expect(api.resumeTypingIndex('', 40)).toBe(0);
    expect(api.resumeTypingIndex('   ', 40)).toBe(0);
    expect(api.resumeTypingIndex(null, 40)).toBe(0);
  });

  it('resumes just past what survived when the editor kept its text', () => {
    expect(api.resumeTypingIndex('hello wor', 40)).toBe(9);
  });

  it('never indexes past the end of the prompt', () => {
    // Content that is not ours must not push the cursor beyond the prompt.
    expect(api.resumeTypingIndex('something else entirely', 10)).toBe(10);
  });
});
