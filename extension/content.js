// Timepass Gemini Extension - Content Script (gemini.google.com)

// ===== ONE-TIME SETUP (guarded against re-injection) =====
if (!window.__timepass_content_loaded) {
  window.__timepass_content_loaded = true;

  // Remote console log interceptor with rate limiting
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;

  const LOG_RATE_LIMIT = 20;
  let logCount = 0;
  let logWindowStart = Date.now();
  let logDropped = 0;

  function sendRemoteLog(level, args) {
    try {
      const now = Date.now();
      if (now - logWindowStart >= 1000) {
        if (logDropped > 0) {
          try {
            chrome.runtime.sendMessage({
              type: "extension_log",
              source: "content",
              level: "warn",
              text: "[Timepass] Dropped " + logDropped + " logs due to rate limit"
            });
          } catch (_) { /* ignore */ }
        }
        logCount = 0;
        logDropped = 0;
        logWindowStart = now;
      }

      if (logCount >= LOG_RATE_LIMIT) {
        logDropped++;
        return;
      }
      logCount++;

      const text = args.map(arg => {
        if (typeof arg === "object") {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      }).join(" ");

      chrome.runtime.sendMessage({
        type: "extension_log",
        source: "content",
        level: level,
        text: text
      });
    } catch (e) {
      // Ignore
    }
  }

  console.log = (...args) => {
    originalLog.apply(console, args);
    sendRemoteLog("log", args);
  };
  console.info = (...args) => {
    originalInfo.apply(console, args);
    sendRemoteLog("info", args);
  };
  console.warn = (...args) => {
    originalWarn.apply(console, args);
    sendRemoteLog("warn", args);
  };
  console.error = (...args) => {
    originalError.apply(console, args);
    sendRemoteLog("error", args);
  };

  window.addEventListener("error", (event) => {
    sendRemoteLog("error", [`Unhandled error: ${event.message} at ${event.filename}:${event.lineno}:${event.colno}`]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    sendRemoteLog("error", [`Unhandled rejection: ${event.reason}`]);
  });

  console.log("[Timepass Content Script] Loaded on gemini.google.com");
}

// ===== ALWAYS-ON FUNCTIONALITY (runs on every injection) =====

if (!window.__timepass_activeMutationObserver) {
  window.__timepass_activeMutationObserver = null;
}

// ========== BROAD DOM READER ENGINE (site-agnostic) ==========

function getMainContentRoot() {
  const candidates = ['main', '[role="main"]', '.conversation-container', '#chat-container', '.chat-history', 'response-container'];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) {
      // Prefer the parent that holds all responses if we matched a single response
      if (sel === 'response-container' && el.parentElement) return el.parentElement;
      return el.closest('main') || el.parentElement || el;
    }
  }
  return document.body;
}

class DomReader {
  snapshot(root) {
    const r = root || getMainContentRoot();
    const nodes = [];
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (n === r) continue;
      const rect = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      nodes.push({
        tag: n.tagName ? n.tagName.toLowerCase() : '',
        cls: typeof n.className === 'string' ? n.className.slice(0, 80) : '',
        id: n.id || '',
        text: (n.innerText || '').trim().slice(0, 200),
        textLen: (n.innerText || '').trim().length,
        rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        visible: !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length),
        aria: n.getAttribute ? (n.getAttribute('aria-label') || '') : ''
      });
      if (nodes.length > 5000) break;
    }
    return {
      ts: Date.now(),
      rootTag: r.tagName,
      text: r.innerText ? r.innerText.slice(0, 8000) : '',
      textLen: r.innerText ? r.innerText.length : 0,
      nodes,
      stats: {
        total: nodes.length,
        visible: nodes.filter(x => x.visible).length,
        buttons: r.querySelectorAll ? r.querySelectorAll('button, [role="button"]').length : 0
      }
    };
  }
}

class DomDiffer {
  diff(prev, curr) {
    if (!prev) return { added: curr.nodes.length, removed: 0, textDelta: curr.textLen, changed: curr.nodes.length, stable: false };
    const prevMap = new Map(prev.nodes.map(n => [n.tag + '|' + n.cls.slice(0, 40) + '|' + (n.text || '').slice(0, 40), n]));
    let added = 0, removed = 0, changed = 0, layoutShifts = 0;
    const currKeys = new Set();
    for (const n of curr.nodes) {
      const k = n.tag + '|' + n.cls.slice(0, 40) + '|' + (n.text || '').slice(0, 40);
      currKeys.add(k);
      const p = prevMap.get(k);
      if (!p) added++;
      else {
        if (p.text !== n.text) changed++;
        if (p.rect && n.rect && (p.rect.x !== n.rect.x || p.rect.y !== n.rect.y)) layoutShifts++;
      }
    }
    for (const k of prevMap.keys()) if (!currKeys.has(k)) removed++;
    return {
      added, removed, changed, layoutShifts,
      textDelta: curr.textLen - prev.textLen,
      stable: added === 0 && removed === 0 && changed === 0 && layoutShifts === 0
    };
  }
}

class CompletionHeuristic {
  constructor(opts) {
    this.settleMs = (opts && opts.settleMs) || 3000;
    this.snapshots = [];
  }
  push(snap) { this.snapshots.push(snap); if (this.snapshots.length > 20) this.snapshots.shift(); }
  hasCopySignal(snap) {
    return snap.nodes.some(n => n.aria && /copy/i.test(n.aria) && n.visible) ||
           /copy/i.test(snap.text) && snap.nodes.some(n => n.tag === 'button' && n.visible);
  }
  hasErrorSignal(snap) {
    return snap.nodes.some(n => n.aria && /error|alert/i.test(n.aria)) ||
           snap.text.toLowerCase().includes('something went wrong') ||
           snap.text.toLowerCase().includes('failed to generate');
  }
  textStableFor(ms) {
    if (this.snapshots.length < 2) return false;
    const now = this.snapshots[this.snapshots.length - 1].ts;
    let stableSince = now;
    for (let i = this.snapshots.length - 1; i > 0; i--) {
      if (this.snapshots[i].text !== this.snapshots[i - 1].text) { stableSince = this.snapshots[i].ts; break; }
      stableSince = this.snapshots[i - 1].ts;
    }
    return (now - stableSince) >= ms;
  }
  isComplete(diff, snap) {
    if (this.hasErrorSignal(snap)) return { done: true, reason: 'error' };
    if (this.hasCopySignal(snap) && this.textStableFor(800)) return { done: true, reason: 'copy+stable' };
    if (diff && diff.stable && this.textStableFor(this.settleMs)) return { done: true, reason: 'stable' };
    return { done: false };
  }
}

class ResponseExtractor {
  extract(snap, prevSnap) {
    // Prefer largest newly-grown text block that is visible
    const candidates = snap.nodes.filter(n => n.visible && n.textLen > 20 && n.textLen < 20000);
    // Sort by text length descending
    candidates.sort((a, b) => b.textLen - a.textLen);
    // Find candidate whose text wasn't in prev snapshot (new content)
    if (prevSnap) {
      for (const c of candidates) {
        if (!prevSnap.text.includes(c.text.slice(0, 60))) return c.text;
      }
    }
    if (candidates[0]) return candidates[0].text;
    // Fallback: raw snapshot text minus header noise
    let t = snap.text || '';
    t = t.replace(/^Gemini said\s*/i, '').replace(/Show code\s*/i, '').trim();
    return t;
  }
}

// Universal waitForElement — MutationObserver + immediate check + timeout
// Pattern from crawl4ai: check immediately, then observe until found or timeout
function waitForElement(selector, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for: ${selector}`));
    }, timeout);
  });
}

// Broad observeResponse — DOM-diff polling, works across Gemini/Claude/DeepSeek etc.
// Falls back to narrow selector if provided for speed.
async function observeResponse(config = {}) {
  const {
    responseSelector = 'response-container',
    responseSelectorStrategy = 'last',
    errorSelectors = ["[role='alert']", "[class*='error']"],
    settleMs = 3000,
    timeoutMs = 60000,
    pollMs = 600
  } = config;

  const reader = new DomReader();
  const differ = new DomDiffer();
  const heuristic = new CompletionHeuristic({ settleMs });
  const extractor = new ResponseExtractor();

  function resolveNarrowEl() {
    const all = document.querySelectorAll(responseSelector);
    if (all.length === 0) return null;
    return responseSelectorStrategy === 'last' ? all[all.length - 1] : all[0];
  }

  // Baseline snapshot before streaming
  let prevSnap = reader.snapshot();
  heuristic.push(prevSnap);
  const deadline = Date.now() + timeoutMs;
  let lastDiff = null;

  console.log('[Timepass] broad observeResponse start, baseline textLen', prevSnap.textLen, 'visible', prevSnap.stats.visible);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const snap = reader.snapshot();
    const diff = differ.diff(prevSnap, snap);
    heuristic.push(snap);
    lastDiff = diff;

    console.log('[Timepass] poll textLen', snap.textLen, 'delta', diff.textDelta, 'added', diff.added, 'changed', diff.changed, 'layout', diff.layoutShifts);

    // Fast-path: narrow selector + copy button if available
    const narrowEl = resolveNarrowEl();
    if (narrowEl) {
      const visibleCopy = document.querySelectorAll('button[aria-label="Copy"], button[aria-label*="Copy"], [data-test-id*="copy"]');
      const hasVisibleCopy = Array.from(visibleCopy).some(b => b.offsetWidth || b.offsetHeight);
      if (hasVisibleCopy) {
        const fresh = resolveNarrowEl();
        if (fresh && fresh.innerText && fresh.innerText.trim().length > 10) {
          await new Promise(r => setTimeout(r, Math.min(settleMs, 800)));
          let t = (fresh.textContent || fresh.innerText || '').trim().replace(/^Gemini said\s*/i, '').trim();
          if (t.length > 5) { console.log('[Timepass] narrow fast-path hit, len', t.length); return t; }
        }
      }
    }

    const c = heuristic.isComplete(diff, snap);
    if (c.done) {
      console.log('[Timepass] broad completion reason', c.reason);
      // Check narrow errors first
      const fresh = resolveNarrowEl();
      if (fresh) {
        for (const sel of errorSelectors) {
          const e = fresh.querySelector(sel);
          if (e && e.innerText && e.innerText.trim()) throw new Error('Gemini error: ' + e.innerText.trim());
        }
      }
      if (c.reason === 'error') throw new Error('Response error detected');
      await new Promise(r => setTimeout(r, 500));
      const finalSnap = reader.snapshot();
      return extractor.extract(finalSnap, prevSnap);
    }
    prevSnap = snap;
  }
  // Timeout: return best effort
  console.log('[Timepass] broad observe timeout, returning extractor fallback');
  const finalSnap = reader.snapshot();
  const fallback = extractor.extract(finalSnap, null);
  if (fallback && fallback.length > 10) return fallback;
  const narrow = resolveNarrowEl();
  if (narrow) {
    let t = (narrow.textContent || narrow.innerText || '').trim().replace(/^Gemini said\s*/i, '').trim();
    if (t) return t;
  }
  throw new Error('Timeout waiting for response completion');
}

// Multi-tier DOM element selector
function findInputEditor() {
  const selectors = [
    "rich-textarea .ql-editor",
    "rich-textarea [contenteditable='true']",
    "[aria-label*='Prompt']",
    "div[role='textbox']",
    "rich-textarea > div > p"
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  return null;
}

// Typing simulation
function simulateTyping(element, text) {
  return new Promise((resolve, reject) => {
    const chunkSize = 15;
    let i = 0;
    const interval = setInterval(() => {
      if (!element.isConnected) {
        clearInterval(interval);
        reject(new Error("Element removed from DOM during typing"));
        return;
      }
      if (i >= text.length) {
        clearInterval(interval);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        resolve();
        return;
      }
      const chunk = text.slice(i, i + chunkSize);
      element.textContent += chunk;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      i += chunkSize;
    }, 30);
  });
}

// Find the Gemini "Send" button using the same tiered selectors as click_send
function findSendButton() {
  const selectors = [
    'gem-icon-button.send-button',
    'gem-icon-button.send-button button',
    '.send-button',
    '.send-button button',
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button[mattooltip*="Send"]',
    'button[aria-label*="Submit"]',
    'button[aria-label*="Generate"]'
  ];

  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn) return btn;
  }
  return null;
}

// Read conversation history from the Gemini sidebar (best-effort, resilient)
function readHistory() {
  try {
    const items = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/app/"]');
    for (const link of links) {
      const url = link.href;
      const title = (link.textContent || "").trim();
      if (!url || seen.has(url)) continue;
      if (!title && url.endsWith("/app")) continue;
      seen.add(url);
      items.push({ title: title || url, url });
    }
    return { success: true, history: items };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Select a conversation from the Gemini sidebar by title or url
function selectHistory(target) {
  const title = (target && target.title || "").trim().toLowerCase();
  const url = target && target.url;
  const links = document.querySelectorAll('a[href*="/app/"]');
  for (const link of links) {
    const matchTitle = title && (link.textContent || "").trim().toLowerCase().includes(title);
    const matchUrl = url && link.href === url;
    if (matchTitle || matchUrl) {
      link.click();
      return { success: true, url: link.href };
    }
  }
  return { success: false, error: "History item not found: " + (title || url || "(no target)") };
}

// Chrome message handler (registered only once per page load)
if (!window.__timepass_listener_registered) {
  window.__timepass_listener_registered = true;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action, payload } = message || {};

    // Live path used by the adapter: type the prompt then click Send.
    if (action === "inject_and_send") {
      (async () => {
        const text = (payload && (payload.prompt || payload.text)) || "";
        const editor = findInputEditor();
        if (!editor) {
          sendResponse({ success: false, error: "Input editor not found" });
          return;
        }
        if (!text) {
          sendResponse({ success: false, error: "Missing payload.prompt" });
          return;
        }

        try {
          await simulateTyping(editor, text);
          const btn = findSendButton();
          if (btn) {
            console.log("[Timepass] clicking send button");
            btn.click();
          } else {
            console.warn("[Timepass] send button NOT found after typing");
          }

          // Wait for response completion (copy button signal)
          const responseText = await observeResponse({
            settleMs: payload?.settleMs || 3000,
            timeoutMs: payload?.timeoutMs || 60000
          });

          sendResponse({
            success: true,
            turnComplete: true,
            text: responseText,
            chatId: window.location.href
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // keep message channel open for async
    }

    if (action === "read_history") {
      sendResponse(readHistory());
      return;
    }

    if (action === "select_history") {
      sendResponse(selectHistory(payload));
      return;
    }

    if (action === "type_prompt") {
      const editor = findInputEditor();
      if (!editor) {
        sendResponse({ success: false, error: "Input editor not found" });
        return;
      }
      if (payload || !payload.text) {
        sendResponse({ success: false, error: "Missing payload.text" });
        return;
      }
      simulateTyping(editor, payload.text).then(() => {
        sendResponse({ success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true; // keep message channel open for async
    }

    if (action === "click_send") {
      const button = findSendButton();

      if (!button) {
        sendResponse({ success: false, error: "Send button not found" });
        return;
      }

      button.click();
      sendResponse({ success: true });
    }

    if (action === "get_status") {
      sendResponse({
        success: true,
        url: window.location.href,
        hasInput: !!findInputEditor()
      });
    }

    if (action === "click_button") {
      try {
        const btn = document.querySelector(payload.selector);
        if (!btn) {
          sendResponse({ success: false, error: "Button not found: " + payload.selector });
          return;
        }
        btn.click();
        sendResponse({ success: true, result: "clicked" });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }

    if (action === "get_page_info") {
      sendResponse({
        success: true,
        url: window.location.href,
        title: document.title,
        fileInputs: document.querySelectorAll("input[type='file']").length,
        dropzones: document.querySelectorAll("[xapfileselectordropzone]").length,
        buttons: document.querySelectorAll("button").length
      });
    }

    // Fallback: any unhandled action must still respond with an object
    sendResponse({ success: false, error: "Unknown action: " + action });
    return;
  });
}

// DOM Subtree Serializer
function serializeSubtree(rootSelector, opts = {}) {
  const MAX_DEPTH = opts.maxDepth || 10;

  function walk(el, depth) {
    if (!el || depth > MAX_DEPTH) return null;

    const node = {
      tag: el.tagName?.toLowerCase() || "",
      className: el.className || "",
      attributes: {},
      children: [],
      visible: el.offsetParent !== null || el.tagName === "BODY",
      inViewport: isElementInViewport(el),
      rect: el.getBoundingClientRect ? {
        x: el.getBoundingClientRect().x,
        y: el.getBoundingClientRect().y,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height
      } : null
    };

    if (el.attributes) {
      for (const attr of el.attributes) {
        node.attributes[attr.name] = attr.value;
      }
    }

    if ("value" in el) node.value = el.value;
    if ("checked" in el) node.checked = el.checked;

    if (depth < MAX_DEPTH) {
      for (const child of el.children) {
        const s = walk(child, depth + 1);
        if (s) node.children.push(s);
      }
      if (el.shadowRoot) {
        node.shadowRoot = [...el.shadowRoot.children]
          .map(c => walk(c, depth + 1)).filter(Boolean);
      }
    }
    return node;
  }

  const root = rootSelector ? document.querySelector(rootSelector) : document.body;
  if (!root) return { ok: false, error: `Selector matched nothing: ${rootSelector}` };
  return { ok: true, url: location.href, title: document.title, tree: walk(root, 0) };
}

function isElementInViewport(el) {
  const rect = el.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}
