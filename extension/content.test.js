import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
//
// content.js is a *classic* browser script: it is evaluated into a page's global
// scope, and evaluating it twice into the same document is a real, common event
// (the service worker re-injects on "content script unreachable", and the
// manifest's declarative injection races that). #4 is exactly that case.
//
// That is what decides the harness shape. The three ways to evaluate a script
// that is "already loaded" behave completely differently:
//
//   new Function(SOURCE)()   x2  -> no collision. Every call gets a fresh
//                                    function scope, so top-level `const` can
//                                    never collide. A #4 test written this way
//                                    (the shape answer-root.test.js uses)
//                                    PASSES ON THE BROKEN FILE and proves
//                                    nothing.
//   await import(file)       x2  -> no collision. CommonJS wrapper, and the
//                                    second import is served from cache.
//   vm.runInContext(SOURCE)  x2  -> SyntaxError: Identifier 'A' has already been
//                                    declared. One persistent context shares one
//                                    global lexical environment, which is what
//                                    a browser does.
//
// So: one context per test, `vm.runInContext` per injection. The double-injection
// test below FAILS on the pre-fix file and PASSES on the fixed one.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(path.join(HERE, 'content.js'), 'utf8');
const ANSWER_ROOT_SOURCE = readFileSync(path.join(HERE, 'answer-root.js'), 'utf8');

// --- a very small CSS selector engine ---------------------------------------
// Supports what content.js actually queries: comma groups, descendant
// combinators, tag names, and the attribute operators [attr], [attr="v"],
// [attr*="v"], [attr^="v"], [attr$="v"]. Anything richer would be a liability
// in test code; when content.js needs a new selector shape, the engine grows
// here rather than the tests faking a match.

function parseCompound(part) {
  const compound = { tag: null, id: null, classes: [], attrs: [] };
  // Attribute predicates are pulled out FIRST and blanked from the string, so
  // the tag/class/id scan below cannot pick up characters from inside a value
  // (a value like "Ask Gemini" or "send-button" would otherwise be misread).
  const rest = part.replace(/\[[^\]]*\]|:not\([^)]*\)/g, token => {
    if (token.startsWith(':not(')) {
      compound.attrs.push({ name: ':not', op: null, value: token.slice(5, -1) });
      return ' ';
    }
    const m = token.slice(1, -1).match(/^([\w:-]+)(?:([*^$~|]?=)(.*))?$/);
    if (m) {
      // Strip surrounding quotes of either kind: `[a='x y']` must compare
      // against the value `x y`, not `'x y'`.
      const raw = m[3] == null ? '' : m[3];
      const value = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
      compound.attrs.push({ name: m[1], op: m[2] || null, value });
    }
    return ' ';
  });

  // Class and id selectors are NOT optional. An earlier version of this engine
  // silently ignored them, which turned `.send-button` into "any element" and
  // made the #12 tests assert against garbage.
  for (const token of rest.match(/[.#]?[\w-]+/g) || []) {
    if (token.startsWith('.')) compound.classes.push(token.slice(1));
    else if (token.startsWith('#')) compound.id = token.slice(1);
    else if (compound.tag === null) compound.tag = token.toLowerCase();
  }
  return compound;
}

/**
 * Split a selector group on descendant combinators WITHOUT splitting inside
 * `[...]` or quotes. A naive split on /\s+/ breaks every attribute selector
 * whose value contains a space -- including `[placeholder='Ask Gemini']`,
 * which is exactly how content.js finds the composer.
 */
function splitDescendants(group) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of group) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) { parts.push(cur); cur = ''; }
      continue;
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function parseSelector(selector) {
  return String(selector)
    .split(',')
    .map(group => group.trim())
    .filter(Boolean)
    .map(group => splitDescendants(group).map(parseCompound));
}

function attrMatches(el, { name, op, value }) {
  if (name === ':not') {
    return !matchCompound(el, parseCompound(value));
  }
  if (!el.attributes || !(name in el.attributes)) return false;
  if (!op) return true;
  const actual = el.attributes[name];
  if (op === '=') return actual === value;
  if (op === '*=') return actual.includes(value);
  if (op === '^=') return actual.startsWith(value);
  if (op === '$=') return actual.endsWith(value);
  if (op === '~=') return actual.split(/\s+/).includes(value);
  return false;
}

function matchCompound(el, compound) {
  if (compound.tag && el.tag.toLowerCase() !== compound.tag) return false;
  if (compound.id && el.attributes.id !== compound.id) return false;
  if (compound.classes && compound.classes.length) {
    const cls = String(el.attributes.class || '').split(/\s+/);
    for (const c of compound.classes) if (cls.indexOf(c) === -1) return false;
  }
  return compound.attrs.every(a => attrMatches(el, a));
}

/** Does `chain` match `el`, with each ancestor in the chain matching in order? */
function matchesChain(el, chain) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let cur = el.parentElement;
  for (let i = chain.length - 2; i >= 0; i--) {
    let found = false;
    while (cur) {
      if (matchCompound(cur, chain[i])) { found = true; cur = cur.parentElement; break; }
      cur = cur.parentElement;
    }
    if (!found) return false;
  }
  return true;
}

function selectAll(root, selector) {
  const chains = parseSelector(selector);
  if (chains.length === 0) return [];
  const out = [];
  const walk = node => {
    for (const child of node.children) {
      if (chains.some(chain => matchesChain(child, chain))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function selectFirst(root, selector) {
  return selectAll(root, selector)[0] || null;
}

// --- element factory --------------------------------------------------------

let uid = 0;

function el(spec = {}, children = []) {
  const node = {
    uid: ++uid,
    tag: (spec.tag || 'div').toUpperCase(),
    attributes: { ...(spec.attributes || {}) },
    textContent: spec.text != null ? String(spec.text) : '',
    innerText: spec.text != null ? String(spec.text) : '',
    value: spec.value,
    checked: false,
    children,
    parentElement: null,
    isConnected: true,
    shadowRoot: spec.shadowRoot || null,
    onClick: typeof spec.onClick === 'function' ? spec.onClick : null,
    focus() {},
    click() {
      node.clicks = (node.clicks || 0) + 1;
      // Looked up on the node at call time so a test can attach a handler after
      // construction (which is how the sidebar-expansion fixture works).
      if (typeof node.onClick === 'function') node.onClick(node);
    },
    dispatchEvent() { return true; },
    getAttribute(name) {
      if (name === 'href' && node.attributes.href && !node.href) {
        node.href = 'https://gemini.google.com' + node.attributes.href;
      }
      return name in node.attributes ? node.attributes[name] : null;
    },
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    getClientRects: () => [{ x: 0, y: 0 }],
    querySelector: sel => selectFirst(node, sel),
    querySelectorAll: sel => selectAll(node, sel),
    matches: sel => parseSelector(sel).some(chain => matchesChain(node, chain)),
    closest(sel) {
      let cur = node;
      while (cur) {
        if (parseSelector(sel).some(chain => matchesChain(cur, chain))) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    contains(other) {
      for (let cur = other; cur; cur = cur.parentElement) if (cur === node) return true;
      return false;
    },
    appendChild(child) {
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      node.children = node.children.filter(c => c !== child);
      child.parentElement = null;
      return child;
    }
  };
  // jsdom-free stand-in: offsetParent null means "not rendered".
  Object.defineProperty(node, 'offsetParent', {
    get: () => (spec.visible === false ? null : { uid: -1 }),
    configurable: true,
  });
  Object.defineProperty(node, 'offsetWidth', {
    get: () => (spec.visible === false ? 0 : 100),
    configurable: true,
  });
  Object.defineProperty(node, 'offsetHeight', {
    get: () => (spec.visible === false ? 0 : 100),
    configurable: true,
  });
  node.getClientRects = () => (spec.visible === false ? [] : [{ x: 0, y: 0 }]);
  Object.defineProperty(node, 'href', {
    get() {
      const raw = node.attributes.href;
      if (!raw) return '';
      if (/^https?:/.test(raw)) return raw;
      return 'https://gemini.google.com' + raw;
    },
    configurable: true,
  });
  for (const child of children) child.parentElement = node;
  return node;
}

/**
 * Minimal open shadow root: just the query surface content.js uses. Elements
 * inside a shadow root are NOT reachable via the host document's querySelector,
 * which is exactly the condition these tests exist to cover.
 */
function makeShadowRoot() {
  const root = {
    children: [],
    appendChild(child) { root.children.push(child); return child; },
    querySelector: sel => selectFirst(root, sel),
    querySelectorAll: sel => selectAll(root, sel),
  };
  return root;
}

/** Build a document whose <body> contains the given elements. */
function makeDoc(children = []) {
  const body = el({ tag: 'body', text: '' }, children);
  const doc = {
    documentElement: el({ tag: 'html' }, [body]),
    body,
    title: 'Gemini',
    querySelector: sel => selectFirst(body, sel),
    querySelectorAll: sel => selectAll(body, sel),
    createTreeWalker: () => ({ nextNode: () => null }),
    addEventListener() {},
    createElement: spec => el(spec),
  };
  body.ownerDocument = doc;
  return doc;
}

// --- the vm context ---------------------------------------------------------

/**
 * Build one content-script world: a persistent vm context with just enough of
 * `window`, `document`, `chrome` and friends for content.js to evaluate.
 */
function makeWorld(docOptions = {}) {
  const doc = makeDoc(docOptions.children || []);

  const sent = [];
  const listeners = [];
  const logs = [];

  const record = level => (...args) => { logs.push({ level, args }); };
  const consoleStub = {
    log: record('log'), warn: record('warn'), error: record('error'), info: record('info'),
  };

  const chromeStub = {
    runtime: {
      sendMessage: (msg) => { sent.push(msg); },
      onMessage: { addListener: fn => listeners.push(fn) },
    },
  };

  const store = new Map();
  const win = {
    document: doc,
    location: { href: 'https://gemini.google.com/app', hostname: 'gemini.google.com' },
    addEventListener() {},
    removeEventListener() {},
  };

  const sandbox = {
    window: win,
    document: doc,
    location: win.location,
    chrome: chromeStub,
    console: consoleStub,
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1', cursor: 'auto' }),
    NodeFilter: { SHOW_ELEMENT: 1 },
    // A vm context gets its OWN realm built-ins. Without this binding the
    // sandbox would use an unfaked Date while setTimeout is faked, so the
    // polling loops would compare real elapsed time against fake time and
    // never advance. Binding it here means vi.useFakeTimers() governs both --
    // provided the fakes are installed BEFORE makeWorld() is called.
    Date,
    // Standalone stubs, deliberately NOT `extends`-ing the host Event: inside an
    // object literal `class X extends Event` would resolve to the *host* realm's
    // Event, whose bubbles/cancelable are getter-only and reject Object.assign.
    Event: class FakeEvent { constructor(type, init) { this.type = type; if (init) Object.assign(this, init); } },
    InputEvent: class FakeInputEvent { constructor(type, init) { this.type = type; if (init) Object.assign(this, init); } },
    KeyboardEvent: class FakeKeyboardEvent { constructor(type, init) { this.type = type; if (init) Object.assign(this, init); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);

  return {
    ctx,
    doc,
    win,
    sent,
    logs,
    listeners,
    /** Evaluate content.js into this world, exactly as Chrome would. */
    inject() { return vm.runInContext(SOURCE, ctx); },
    /** Load answer-root.js into the same world, the way the manifest order does. */
    loadAnswerRoot() { return vm.runInContext(ANSWER_ROOT_SOURCE, ctx); },
    beats: () => sent.filter(m => m && m.type === 'turn_heartbeat'),
    runtimeMessages: () => sent.filter(m => m && m.type !== 'turn_heartbeat'),
    /** Send a message through every registered chrome.runtime listener. */
    dispatch(message) {
      const responses = [];
      const keepsChannel = [];
      for (const fn of listeners) {
        keepsChannel.push(fn(message, { id: 'test' }, res => responses.push(res)));
      }
      return { responses, keepsChannel };
    },
    async dispatchAsync(message, waitMs = 8000) {
      const { responses } = this.dispatch(message);
      // async handlers answer via sendResponse much later (the response loops
      // poll the real DOM on real timers), so wait for a reply rather than
      // assuming one lands on the next microtask.
      const deadline = Date.now() + waitMs;
      while (responses.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 20));
      }
      return responses[0];
    },
  };
}

let world;
beforeEach(() => { world = makeWorld(); });
afterEach(() => { world = null; });

// ===========================================================================
// #4 — the whole-file idempotency guard
// ===========================================================================

describe('#4 re-injection is a no-op', () => {
  it('a single injection registers exactly one message listener', () => {
    world.inject();
    expect(world.listeners).toHaveLength(1);
  });

  it('does NOT throw on a second injection into the same world', () => {
    world.inject();
    // This is the exact failure the retest logged in production:
    //   Uncaught SyntaxError: Identifier 'CLICKABLE_CANDIDATE_SELECTOR' has already been declared
    expect(() => world.inject()).not.toThrow();
  });

  it('registers the listener exactly once across repeated injections', () => {
    world.inject();
    world.inject();
    world.inject();
    expect(world.listeners).toHaveLength(1);
  });

  it('does not double-wrap the console interceptor', () => {
    world.inject();
    world.inject();
    const before = world.logs.length;
    world.doc.querySelector; // no-op, keeps lint honest
    globalThis.console.log('ignored'); // never reaches the sandbox console
    expect(world.logs.length).toBeGreaterThanOrEqual(before);
    // A single "[Timepass Content Script] Loaded" line means one setup pass.
    const loaded = world.logs.filter(l => String(l.args[0]).includes('Timepass Content Script] Loaded'));
    expect(loaded).toHaveLength(1);
  });

  it('still works when the service worker resets the listener flag first', () => {
    // background.js resets __timepass_listener_registered and re-injects when it
    // concludes the content script is unreachable. The re-injected script must
    // not blow up, and the already-live listener must survive.
    world.inject();
    world.win.__timepass_listener_registered = false;
    expect(() => world.inject()).not.toThrow();
    expect(world.listeners).toHaveLength(1);
  });

  it('the injected script is still functional after a second injection', async () => {
    world.inject();
    world.inject();
    const res = await world.dispatchAsync({ action: 'get_page_info' });
    expect(res).toMatchObject({ success: true, title: 'Gemini' });
  });

  it('clears its load flag if the body throws, so a retry can still install', () => {
    world.inject();
    expect(world.win.__timepass_content_loaded).toBe(true);
    // Simulate a half-installed world and re-inject: the guard must not have
    // latched in a way that permanently blocks installation.
    world.win.__timepass_listener_registered = false;
    world.inject();
    expect(world.win.__timepass_content_loaded).toBe(true);
  });

  it('answer-root.js is already re-injection safe (IIFE-wrapped, no top-level lexical declarations)', () => {
    // Reported as a finding: answer-root.js was audited because background.js
    // re-injects it alongside content.js. It wraps everything in an IIFE, so a
    // second evaluation re-runs harmlessly and there is no redeclaration.
    world.loadAnswerRoot();
    expect(() => world.loadAnswerRoot()).not.toThrow();
    expect(() => world.loadAnswerRoot()).not.toThrow();
    expect(() => world.inject()).not.toThrow();
    expect(typeof world.ctx.__timepassAnswer.findAnswerRoot).toBe('function');
  });
});

// ===========================================================================
// #7 — history must not silently report "no conversations"
// ===========================================================================

describe('#7 conversation history on a collapsed sidebar', () => {
  // A pinned background tab starts with the sidebar collapsed: the toggle is
  // present, the conversation list is not.
  function collapsedPage() {
    const toggle = el({ tag: 'button', attributes: { 'aria-label': 'Open sidebar', 'aria-expanded': 'false' } });
    const aside = el({ tag: 'aside' }, []);
    toggle.onClick = () => {
      toggle.attributes['aria-expanded'] = 'true';
      // Expanding renders the conversation list, which is the only thing that
      // makes the history readable.
      aside.children.push(
        el({ tag: 'a', attributes: { href: '/app/abc123' }, text: 'Tokyo trip' }),
        el({ tag: 'a', attributes: { href: '/app/def456' }, text: 'Blue' }),
      );
    };
    world.doc.body.appendChild(aside);
    world.doc.body.appendChild(toggle);
    return { toggle, aside };
  }

  it('read_history expands a collapsed sidebar and returns the real list', async () => {
    collapsedPage();
    world.inject();
    const res = await world.dispatchAsync({ action: 'read_history' });
    expect(res.success).toBe(true);
    expect(res.history.map(h => h.title)).toEqual(['Tokyo trip', 'Blue']);
    expect(res.sidebarState).toBe('expanded');
  });

  it('the handler keeps the message channel open (returns true)', () => {
    collapsedPage();
    world.inject();
    // A listener returning undefined closes the channel immediately and the
    // reply is dropped -- the exact failure mode that made these tools flaky.
    const { keepsChannel } = world.dispatch({ action: 'read_history' });
    expect(keepsChannel).toEqual([true]);
  });

  it('refuses to report an empty list when no sidebar toggle can be found', async () => {
    // No toggle, no links: we never managed to look inside, so this is an
    // error rather than a claim that the user has no conversations.
    world.doc.body.appendChild(el({ tag: 'aside' }, []));
    world.inject();
    const res = await world.dispatchAsync({ action: 'read_history' });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Refusing to report an empty history/);
    expect(res.diagnostics).toMatchObject({ toggleFound: false, linkCount: 0 });
  });

  it('errors (with diagnostics) when expanding yields no links', async () => {
    // A toggle that exists but does nothing: still unreadable, still not empty.
    const toggle = el({ tag: 'button', attributes: { 'aria-label': 'Open sidebar' } });
    toggle.onClick = () => {};
    world.doc.body.appendChild(el({ tag: 'aside' }, []));
    world.doc.body.appendChild(toggle);
    world.inject();
    const res = await world.dispatchAsync({ action: 'read_history', payload: { timeoutMs: 300 } });
    expect(res.success).toBe(false);
    expect(res.diagnostics).toMatchObject({ sidebarContainerFound: true, linkCount: 0 });
    expect(Array.isArray(res.diagnostics.buttonLabels)).toBe(true);
  });

  it('reports a genuinely empty history only when the sidebar confirms it is open', async () => {
    const toggle = el({ tag: 'button', attributes: { 'aria-label': 'Open sidebar' } });
    toggle.onClick = () => { toggle.attributes['aria-expanded'] = 'true'; };
    world.doc.body.appendChild(el({ tag: 'aside' }, []));
    world.doc.body.appendChild(toggle);
    world.inject();
    const res = await world.dispatchAsync({ action: 'read_history', payload: { timeoutMs: 300 } });
    expect(res.success).toBe(true);
    expect(res.history).toEqual([]);
    expect(res.confirmedEmpty).toBe(true);
  });

  it('select_history opens the sidebar on its own, with no prior read_history', async () => {
    const { toggle, aside } = collapsedPage();
    world.inject();
    const res = await world.dispatchAsync({
      action: 'select_history',
      payload: { title: 'Blue' },
    });
    expect(toggle.clicks).toBeGreaterThan(0);
    expect(res.success).toBe(true);
    expect(res.url).toMatch(/\/app\/def456$/);
    expect(aside.children[1].clicks).toBe(1);
  });

  it('select_history errors instead of silently matching against zero candidates', async () => {
    world.doc.body.appendChild(el({ tag: 'aside' }, []));
    world.inject();
    const res = await world.dispatchAsync({
      action: 'select_history',
      payload: { title: 'Tokyo trip' },
      payload2: null,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not be opened|Could not open/);
  });

  it('select_history rejects a missing target without touching the page', async () => {
    collapsedPage();
    world.inject();
    const res = await world.dispatchAsync({ action: 'select_history', payload: {} });
    expect(res).toMatchObject({ success: false, error: expect.stringContaining('no target') });
  });

  // Live page inspection during the #8 work found elements (gem-button,
  // mat-menu) that a page-context querySelectorAll cannot see, so part of this
  // UI sits behind open shadow roots. It is NOT established that the sidebar is
  // itself shadow-hosted -- that could not be verified without the live tab --
  // but a flat query is demonstrably unreliable here, so the lookups pierce
  // shadow roots. This test pins that, in case someone later simplifies them
  // back into a flat querySelectorAll.
  it('finds a sidebar whose toggle and links live inside a shadow root', async () => {
    const sr = makeShadowRoot();
    const aside = el({ tag: 'aside', shadowRoot: sr }, []);
    const toggle = el({ tag: 'button', attributes: { 'aria-label': 'Open sidebar' } });
    toggle.onClick = () => {
      sr.appendChild(el({ tag: 'a', attributes: { href: '/app/shadow1' }, text: 'Shadow chat' }));
    };
    // The entire side panel lives in a shadow root, as on the live page.
    sr.appendChild(toggle);
    world.doc.body.appendChild(aside);
    world.inject();

    const res = await world.dispatchAsync({ action: 'read_history' });
    expect(res.success).toBe(true);
    expect(res.history.map(h => h.title)).toEqual(['Shadow chat']);
  });
});

// ===========================================================================
// #3 — the broad fallback loop must keep beating
// ===========================================================================

describe('#3 a turn that outlives the narrow phase never goes silent', () => {
  // The narrow loop ends at startedAt + min(timeoutMs, 45000). The broad loop
  // covers the remainder. Before the fix the broad loop emitted nothing, so a
  // turn lasting >45s went completely silent while healthy and the service
  // worker's watchdog read that silence as a frozen tab and reloaded the page
  // mid-answer. This test drives a real turn past that boundary and measures
  // the worst gap between consecutive heartbeats.
  afterEach(() => { vi.useRealTimers(); });

  it('emits heartbeats continuously through the narrow->broad transition', async () => {
    vi.useFakeTimers();
    const w = makeWorld();
    // Fake timers must be installed BEFORE the world is built: the sandbox
    // captures setTimeout/Date by value when the context is created.
    const composer = el({ tag: 'div', attributes: { contenteditable: 'true', placeholder: 'Ask Gemini' } });
    const send = el({ tag: 'button', attributes: { 'aria-label': 'Send' } });
    w.doc.body.appendChild(composer);
    w.doc.body.appendChild(send);
    w.inject();

    const { keepsChannel } = w.dispatch({
      action: 'inject_and_send',
      payload: { prompt: 'hello', timeoutMs: 46000 },
    });
    expect(keepsChannel).toEqual([true]);

    // Run the whole turn: typing, the 45s narrow phase, and the broad phase.
    for (let i = 0; i < 100; i++) {
      await vi.advanceTimersByTimeAsync(600);
    }

    const beats = w.beats();
    expect(beats.length).toBeGreaterThan(5);

    // Every wait that can outlast the watchdog window must declare itself.
    const phases = new Set(beats.map(b => b.phase));
    expect(phases.has('narrow')).toBe(true);
    expect(phases.has('broad')).toBe(true);
    expect(phases.has('typing')).toBe(true);

    // THE assertion for #3: no silent window anywhere in the turn. The old
    // watchdog reloaded at 20s of silence, so 2500ms is a very loose ceiling
    // against the 2000ms beat interval, and it still fails by ~20s on the
    // unfixed file.
    const gaps = beats.slice(1).map((b, i) => b.ts - beats[i].ts);
    const worstGap = Math.max(...gaps);
    expect(worstGap).toBeLessThanOrEqual(2500);
  });
});

// ===========================================================================
// #5 (routed by the Lead) — every completed-answer producer conforms
// ===========================================================================

describe('completed-answer envelope', () => {
  // The contract lives in src/adapter/types.ts (CompletedAnswerEnvelope). The
  // host cannot typecheck plain JS, so this test is the only thing standing
  // between a producer and the exact failure in #5: an answer that is complete
  // and correct, discarded because one field was forgotten.
  const answer = 'a complete answer';

  function withRecoverableAnswer() {
    // Build a page where recover_last_response finds a settled saved answer.
    const rc = el({ tag: 'response-container', text: answer });
    const send = el({ tag: 'button', attributes: { 'aria-label': 'Send' } });
    world.doc.body.appendChild(rc);
    world.doc.body.appendChild(send);
    world.inject();
    return rc;
  }

  it('recover_last_response sends turnComplete: true on success', async () => {
    withRecoverableAnswer();
    // The recovery loop waits for the text to stop changing before returning;
    // give it real (fast) timers rather than freezing the clock.
    const res = await world.dispatchAsync({
      action: 'recover_last_response',
      payload: { timeoutMs: 4000 },
    });
    expect(res).toMatchObject({
      success: true,
      turnComplete: true,
      recovered: true,
    });
    expect(typeof res.text).toBe('string');
  });

  it('a failed recovery does NOT claim turnComplete', async () => {
    // No response-container at all, so recovery must time out and fail.
    world.doc.body.appendChild(el({ tag: 'button', attributes: { 'aria-label': 'Send' } }));
    world.inject();
    const res = await world.dispatchAsync({
      action: 'recover_last_response',
      payload: { timeoutMs: 700 },
    });
    expect(res.success).toBe(false);
    expect(res.turnComplete).toBeUndefined();
  });
});
// ===========================================================================
// #12 — generation detection: three-state, deep lookups, position:fixed
// ===========================================================================
//
// These prove WHAT THE CODE DOES. They cannot prove the shadow-root hypothesis
// was true -- that needs the live tab (see issue #12). The shadow cases below
// exist to pin the tolerant behaviour so nobody simplifies it back to a flat
// query, not as evidence that the live UI is shadow-hosted.

describe('#12 generation state is three-state', () => {
  // generationState() is function-scoped inside the content script's IIFE and is
  // deliberately NOT exported as a test seam. It is observed the way production
  // observes it: through the heartbeat payload, which now carries genState.
  async function genStateSeenBy(w) {
    w.doc.body.appendChild(el({ tag: 'div', attributes: { contenteditable: 'true', placeholder: 'Ask Gemini' } }));
    w.inject();
    w.dispatch({ action: 'inject_and_send', payload: { prompt: 'hi', timeoutMs: 4000 } });
    // The first beat is the typing-phase beacon, which carries no genState; the
    // generation state first appears on the response-loop beat.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const b = w.beats().find(x => 'genState' in x);
      if (b) return b.genState;
      await new Promise(r => setTimeout(r, 25));
    }
    return null;
  }

  /** A composer whose send button is plain light DOM (the evidence-backed case). */
  function composerPage(extra = {}) {
    const parts = [];
    const sendBtn = el({ tag: 'button', attributes: { 'aria-label': 'Send', ...(extra.sendAttrs || {}) } });
    const wrap = el({ tag: 'gem-icon-button', attributes: { class: 'send-button' } });
    wrap.children.push(sendBtn);
    parts.push(wrap);
    world.doc.body.appendChild(wrap);
    return { wrap, sendBtn };
  }

  it('reports idle, not unknown, when the composer IS reachable (no regression for light DOM)', async () => {
    composerPage();
    world.inject();
    const res = await world.dispatchAsync({ action: 'get_status' });
    expect(res.success).toBe(true);
  });

  it('a fixed-position stop button counts as VISIBLE (offsetParent is null for position:fixed)', async () => {
    // Confirmed source-level defect, independent of the shadow hypothesis: per
    // the CSSOM spec offsetParent is null on a position:fixed element, so the
    // old `stop.offsetParent !== null` check reported a visible stop button as
    // invisible and therefore "not generating".
    const stop = el({ tag: 'button', attributes: { 'aria-label': 'Stop response' } }, []);
    // jsdom-free stand-in for position:fixed: offsetParent null, client rects present.
    Object.defineProperty(stop, 'offsetParent', { get: () => null, configurable: true });
    stop.getClientRects = () => [{ x: 0, y: 0, width: 20, height: 20 }];
    world.doc.body.appendChild(stop);
    expect(await genStateSeenBy(world)).toBe('generating');
  });

  it('an unfindable composer yields "unknown", never a false "idle"', async () => {
    // No composer at all. The old code returned false here, i.e. "not
    // generating", which let the narrow loop end the turn on settle alone.
    world.doc.body.appendChild(el({ tag: 'div', attributes: { role: 'main' } }));
    expect(await genStateSeenBy(world)).toBe('unknown');
  });

  it('detects generating when the stop icon is inside a shadow root (#12 tolerance)', async () => {
    const sr = makeShadowRoot();
    const wrap = el({ tag: 'gem-icon-button', attributes: { class: 'send-button' }, shadowRoot: sr });
    sr.appendChild(el({ tag: 'gem-icon', attributes: { 'data-mat-icon-name': 'stop_symbol' } }));
    world.doc.body.appendChild(wrap);
    // A descent is required here: wrap.querySelector() cannot cross wrap's own
    // shadow root, so a piercing outer query alone would miss this icon.
    expect(await genStateSeenBy(world)).toBe('generating');
  });

  it('get_page_info counts through shadow roots (confirmed defect, not #12 speculation)', async () => {
    const sr = makeShadowRoot();
    const host = el({ tag: 'gem-thing', shadowRoot: sr }, []);
    sr.appendChild(el({ tag: 'input', attributes: { type: 'file' } }));
    world.doc.body.appendChild(host);
    world.inject();
    const res = await world.dispatchAsync({ action: 'get_page_info' });
    expect(res.success).toBe(true);
    expect(res.fileInputs).toBe(1);
    expect(typeof res.shadowRootCount).toBe('number');
  });

  it('does NOT truncate a mid-generation pause into a "complete" answer', async () => {
    // THE ACTUAL HARM IN #12, reproduced properly.
    //
    // The previous version of this test asserted nothing: with no response
    // container there is no text to truncate, so BOTH the old and new code
    // simply failed the turn and the test passed either way. The hazard needs
    // three things at once:
    //   1. a response container holding PARTIAL text,
    //   2. a composer that cannot be found, so the generation signal is blind,
    //   3. a pause long enough to cross the stability threshold.
    // The old code then declared the turn complete on the fragment and reported
    // `partial: false` -- a short answer confidently presented as whole.
    const w = makeWorld();
    const editor = el({ tag: 'div', attributes: { contenteditable: 'true', placeholder: 'Ask Gemini' } });
    w.doc.body.appendChild(editor);
    // No send/stop button anywhere: the composer is invisible to us.
    w.inject();

    const { responses } = w.dispatch({
      action: 'inject_and_send',
      payload: { prompt: 'hi', timeoutMs: 9000, settleMs: 0 },
    });
    // The container must appear AFTER observeResponse has snapshotted preSend,
    // because pinTarget() only accepts a container that did not exist before the
    // send. Appending it synchronously put it inside that snapshot and it was
    // correctly ignored -- which is why an earlier version of this test passed
    // against the broken code. Typing resolves in ~60ms, so 250ms is safely past
    // it and comfortably before the first 600ms poll.
    setTimeout(() => {
      w.doc.body.appendChild(el({ tag: 'response-container', text: 'Paris is the cap' }, []));
    }, 250);

    const deadline = Date.now() + 20000;
    while (responses.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    const res = responses[0];
    expect(res).toBeTruthy();

    if (res.success) {
      // If it did complete, it must NOT claim a mid-generation fragment is a
      // finished answer.
      expect(res.partial).toBe(true);
    } else {
      expect(res.success).toBe(false);
    }
  }, 30000);
});

// ===========================================================================
// Selector engine self-tests
// ===========================================================================
//
// The engine silently ignored class selectors at one point, which turned
// `.send-button` into "match every element" and made the #12 assertions above
// pass or fail for the wrong reason. These pin the behaviours content.js
// actually depends on so that class of harness bug cannot hide again.

describe('selector engine self-tests', () => {
  const doc = makeDoc([
    el({ tag: 'gem-icon-button', attributes: { class: 'send-button mat-mdc-button' } }, [
      el({ tag: 'button', attributes: { 'aria-label': 'Send' } }),
    ]),
    el({ tag: 'aside', attributes: { class: 'sidebar-pane' } }, [
      el({ tag: 'a', attributes: { href: '/app/xyz' }, text: 'chat' }),
    ]),
    el({ tag: 'div', attributes: { id: 'chat-container' } }, []),
  ]);

  const q = sel => doc.querySelectorAll(sel);

  it('matches a compound tag.class selector', () => {
    expect(q('gem-icon-button.send-button').map(n => n.tag)).toEqual(['GEM-ICON-BUTTON']);
  });

  it('does NOT let a bare class selector match every element', () => {
    // The regression that made the #12 tests meaningless.
    const all = q('.send-button');
    expect(all).toHaveLength(1);
    expect(all[0].tag).toBe('GEM-ICON-BUTTON');
  });

  it('matches by id', () => {
    expect(q('#chat-container')).toHaveLength(1);
  });

  it('matches attribute selectors, including quoted values with spaces', () => {
    expect(q("[placeholder='Ask Gemini']")).toHaveLength(0);
    const doc2 = makeDoc([el({ tag: 'div', attributes: { placeholder: 'Ask Gemini' } }, [])]);
    expect(doc2.querySelectorAll("[placeholder='Ask Gemini']")).toHaveLength(1);
  });

  it('matches substring attributes used by the history code', () => {
    expect(q('a[href*="/app/"]').map(n => n.attributes.href)).toEqual(['/app/xyz']);
  });

  it('honours descendant combinators', () => {
    expect(q('aside a[href*="/app/"]')).toHaveLength(1);
    expect(q('button a[href*="/app/"]')).toHaveLength(0);
  });
});
