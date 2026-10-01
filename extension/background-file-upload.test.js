import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Tests for the in-page helper that extension/background.js injects for
 * `file_upload`.
 *
 * The helper is a string constant inside a service-worker script, so it is
 * lifted out of the real file and evaluated here rather than imported. That is
 * deliberate: these tests exercise the code that actually ships, so a refactor
 * that quietly weakens the selector walk fails here.
 *
 * The old chain's defect was structural and cannot be shown by a unit test on
 * the DOM alone: it searched for the file input *inside* a shadow root, tagged
 * it, and then asked CDP to re-find it from the document node — which cannot
 * cross a shadow boundary. The fix is that the helper returns the element and
 * its handle is what gets handed to DOM.setFileInputFiles. So there is also a
 * source-level guard below asserting the broken lookup is gone.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKGROUND = readFileSync(path.join(HERE, 'background.js'), 'utf8');

/** The file_upload block, so assertions cannot be satisfied by unrelated code. */
const FILE_UPLOAD_BLOCK = BACKGROUND.slice(
  BACKGROUND.indexOf('if (action === "file_upload")'),
  BACKGROUND.indexOf('if (action === "get_page_info")')
);

let helper;
let originalDocument;
let originalGetComputedStyle;

beforeAll(() => {
  const literal = FILE_UPLOAD_BLOCK.match(/const PAGE_HELPER_JS = `([\s\S]*?)`;/);
  expect(literal, 'background.js must define PAGE_HELPER_JS').toBeTruthy();
  // Evaluate the template literal exactly as the service worker does, so the
  // backslash escaping in the injected source is covered too.
  const source = new Function('return `' + literal[1] + '`;')();
  helper = new Function('return (' + source + ');')();
  originalDocument = globalThis.document;
  originalGetComputedStyle = globalThis.getComputedStyle;
});

afterAll(() => {
  globalThis.document = originalDocument;
  globalThis.getComputedStyle = originalGetComputedStyle;
});

/* ------------------------------------------------------------------ *
 * A DOM small enough to build by hand. It implements only what the
 * helper touches: matches(), getAttribute, textContent, click,
 * getBoundingClientRect, shadowRoot and querySelectorAll('*').
 * ------------------------------------------------------------------ */

/**
 * Supports the selector shapes the helper actually uses: `tag`, `[attr]`,
 * `[attr="value"]` and the compound `tag[attr="value"]`, in either quote style.
 */
function matchesOne(el, selector) {
  const m = selector.match(/^([a-zA-Z][\w-]*)?(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/);
  if (!m) return false;
  const [, tag, attr, value] = m;
  if (tag && el.tag.toLowerCase() !== tag.toLowerCase()) return false;
  if (attr) {
    if (!(attr in el.attrs)) return false;
    if (value !== undefined && el.attrs[attr] !== value) return false;
  }
  return Boolean(tag || attr);
}

function makeEl(tag, { attrs = {}, text = '', style = {}, shadow = null, rect, children = [] } = {}) {
  const el = {
    tag,
    attrs,
    text,
    style,
    shadowRoot: null,
    children,
    clicks: 0,
    rect: rect || { width: 12, height: 12 },
    matches(selectorList) {
      return selectorList.split(',').some((s) => matchesOne(this, s.trim()));
    },
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null;
    },
    get textContent() {
      return this.text;
    },
    contains(node) {
      if (node === this) return true;
      const stack = [...(this.children || []), ...(this.shadowRoot ? this.shadowRoot.nodes() : [])];
      return stack.some((child) => (child.contains ? child.contains(node) : child === node));
    },
    getBoundingClientRect() {
      return this.rect;
    },
    click() {
      this.clicks += 1;
    },
  };
  if (shadow) el.shadowRoot = makeRoot({ children: shadow });
  return el;
}

/** Light-DOM descendants of a node, in document order. */
function descendants(el, out = []) {
  for (const child of el.children || []) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

/**
 * The block with comments removed. The structural guards below assert about
 * code, and the code explains the defect it replaces in prose that names the
 * very commands being asserted absent.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function makeRoot(content) {
  const roots = Array.isArray(content) ? content : [content];
  const all = () => roots.flatMap((r) => descendants(r));
  return {
    nodes: all,
    querySelectorAll: (selector) => {
      const list = all();
      return selector === '*' ? list : list.filter((el) => el.matches(selector));
    },
    querySelector: (selector) => all().find((el) => el.matches(selector)) || null,
  };
}

/** Install a tree as the global document for one call of the helper. */
function mount(roots) {
  const all = () => roots.flatMap((r) => descendants(r));
  globalThis.document = {
    querySelectorAll: (selector) => {
      const list = all();
      return selector === '*' ? list : list.filter((el) => el.matches(selector));
    },
    querySelector: (selector) => all().find((el) => el.matches(selector)) || null,
  };
  globalThis.getComputedStyle = (el) =>
    Object.assign({ visibility: 'visible', display: 'block', opacity: '1' }, el.style);
}

describe('file_upload: find-input', () => {
  it('returns a file input from the light DOM', () => {
    const input = makeEl('input', { attrs: { type: 'file' } });
    mount([{ children: [input] }]);

    expect(helper('find-input')).toBe(input);
  });

  it('returns a file input that exists only inside a shadow root', () => {
    // The case the old chain could never deliver: the element is reachable from
    // the page, and the helper hands back the element itself rather than a
    // description that has to be looked up again from the document node.
    const input = makeEl('input', { attrs: { type: 'file' } });
    const host = makeEl('gem-button', { shadow: [input] });
    mount([{ children: [host] }]);

    expect(helper('find-input')).toBe(input);
  });

  it('descends through nested shadow roots', () => {
    const input = makeEl('input', { attrs: { type: 'file' } });
    const inner = makeEl('div', { shadow: [input] });
    const outer = makeEl('custom-el', { shadow: [inner] });
    mount([{ children: [outer] }]);

    expect(helper('find-input')).toBe(input);
  });

  it('returns null when the page has no file input', () => {
    mount([{ children: [makeEl('button'), makeEl('div', { text: 'hello' })] }]);

    expect(helper('find-input')).toBeNull();
  });

  it('does not treat a text field as a file input', () => {
    mount([{ children: [makeEl('input', { attrs: { type: 'text' } })] }]);

    expect(helper('find-input')).toBeNull();
  });

  it('finds an input that only appears after the menu is opened', () => {
    const menuHost = makeEl('mat-menu', {});
    const input = makeEl('input', { attrs: { type: 'file' } });
    const page = [{ children: [menuHost] }];
    mount(page);
    expect(helper('find-input')).toBeNull();

    menuHost.shadowRoot = makeRoot({ children: [input] });
    mount(page);
    expect(helper('find-input')).toBe(input);
  });
});

describe('file_upload: open-menu', () => {
  it('clicks the control matching the known aria-label', () => {
    const exact = makeEl('button', { attrs: { 'aria-label': 'Upload and tools' } });
    const decoy = makeEl('button', { text: 'Something else' });
    mount([{ children: [decoy, exact] }]);

    const res = helper('open-menu');

    expect(res.clicked).toBe(true);
    expect(res.how).toContain('exact');
    expect(exact.clicks).toBe(1);
    expect(decoy.clicks).toBe(0);
  });

  it('falls back to a visible control named for uploading when the exact label is gone', () => {
    const drifted = makeEl('button', { attrs: { 'aria-label': 'Attach files' } });
    mount([{ children: [drifted] }]);

    const res = helper('open-menu');

    expect(res.clicked).toBe(true);
    expect(res.how).toContain('Attach files');
    expect(drifted.clicks).toBe(1);
  });

  it('ignores a hidden upload control and reports what it did see', () => {
    const hidden = makeEl('button', {
      attrs: { 'aria-label': 'Upload and tools' },
      style: { display: 'none' },
    });
    const other = makeEl('button', { attrs: { 'aria-label': 'New chat' } });
    mount([{ children: [hidden, other] }]);

    const res = helper('open-menu');

    expect(res.clicked).toBe(false);
    expect(res.how).toContain('no visible');
    expect(res.candidates).toContain('Upload and tools');
    expect(res.candidates).toContain('New chat');
    expect(hidden.clicks).toBe(0);
  });

  it('ignores a zero-size control', () => {
    const collapsed = makeEl('button', {
      attrs: { 'aria-label': 'Upload and tools' },
      rect: { width: 0, height: 0 },
    });
    mount([{ children: [collapsed] }]);

    expect(helper('open-menu').clicked).toBe(false);
  });

  it('finds the trigger inside a shadow root', () => {
    const trigger = makeEl('button', { attrs: { 'aria-label': 'Upload and tools' } });
    const host = makeEl('gem-button', { shadow: [trigger] });
    mount([{ children: [host] }]);

    expect(helper('open-menu').clicked).toBe(true);
    expect(trigger.clicks).toBe(1);
  });
});

describe('file_upload: click-upload-item', () => {
  it('matches a row whose label carries a trailing badge', () => {
    // The old exact-equality check never matched "Upload files 3".
    const row = makeEl('mat-list-item', { text: 'Upload files 3' });
    mount([{ children: [row] }]);

    const res = helper('click-upload-item');

    expect(res.clicked).toBe(true);
    expect(res.how).toContain('Upload files 3');
    expect(row.clicks).toBe(1);
  });

  it('matches despite surrounding and internal whitespace', () => {
    const row = makeEl('button', { text: '  Upload\n  from   device ' });
    mount([{ children: [row] }]);

    expect(helper('click-upload-item').clicked).toBe(true);
    expect(row.clicks).toBe(1);
  });

  it('clicks the innermost matching element, not its wrapper', () => {
    const inner = makeEl('span', { text: 'Upload files' });
    const wrapper = makeEl('div', { children: [inner], text: 'Upload files' });
    mount([{ children: [wrapper] }]);

    helper('click-upload-item');

    expect(inner.clicks).toBe(1);
    expect(wrapper.clicks).toBe(0);
  });

  it('treats a position:fixed menu row as visible', () => {
    // Overlay menus are frequently position:fixed, for which offsetParent is
    // null even when the row is on screen and clickable.
    const row = makeEl('mat-menu-item', { text: 'Upload from device' });
    expect(row.getBoundingClientRect().width).toBeGreaterThan(0);
    mount([{ children: [row] }]);

    const res = helper('click-upload-item');

    expect(res.clicked).toBe(true);
    expect(row.clicks).toBe(1);
  });

  it('does not click a hidden row and reports the menu contents', () => {
    const hidden = makeEl('mat-menu-item', {
      text: 'Upload files',
      style: { visibility: 'hidden' },
    });
    const other = makeEl('mat-menu-item', { text: 'Import from Google Drive' });
    mount([{ children: [hidden, other] }]);

    const res = helper('click-upload-item');

    expect(res.clicked).toBe(false);
    expect(res.candidates).toContain('Import from Google Drive');
    expect(hidden.clicks).toBe(0);
  });

  it('rejects an unknown mode instead of silently doing nothing', () => {
    mount([{ children: [makeEl('button')] }]);

    const res = helper('no-such-mode');

    expect(res.clicked).toBe(false);
    expect(res.how).toContain('unknown mode');
  });
});

describe('file_upload: structural guard', () => {
  it('does not re-find the input from the document node with DOM.querySelector', () => {
    // The defect this replaces: the page tagged the input, then CDP was asked to
    // look it up again from the document node. DOM.querySelector takes only
    // nodeId + selector and has no pierce option, so that lookup could never
    // return a node inside a shadow root.
    expect(stripComments(FILE_UPLOAD_BLOCK)).not.toContain('DOM.querySelector');
  });

  it('does not tag the input and rely on a data attribute to find it again', () => {
    expect(stripComments(FILE_UPLOAD_BLOCK)).not.toContain('data-timepass-target');
  });

  it('sets files through a handle, not through a document-scoped node id', () => {
    const code = stripComments(FILE_UPLOAD_BLOCK);
    expect(code).toContain('DOM.setFileInputFiles');
    expect(code).toContain('objectId');
  });

  it('keeps the debugger detached on the failure path', () => {
    expect(stripComments(FILE_UPLOAD_BLOCK)).toContain('chrome.debugger.detach');
  });

  it('reports the failing step rather than a single aggregate sentence', () => {
    const code = stripComments(FILE_UPLOAD_BLOCK);
    expect(code).toContain('trace.join');
    expect(code).toContain('note(');
  });
});