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
        } catch { /* ignore */ }
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
    } catch {
      // Ignore remote log failures
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

const CLICKABLE_CANDIDATE_SELECTOR = 'button, [role="button"], a[href], input, select, textarea, [contenteditable="true"], [onclick], mat-icon-button, gem-icon-button';
const MAX_STYLE_READS_PER_SNAPSHOT = 2000;

function scoreNode(el, rect) {
  const style = getComputedStyle(el);
  const visible = !!(rect.w && rect.h) && style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity) > 0.05;
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const tagSet = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea';
  const clickable = visible && el.getAttribute('aria-disabled') !== 'true' && (style.cursor === 'pointer' || tagSet || role === 'button' || el.hasAttribute('onclick') || el.getAttribute('contenteditable') === 'true');
  const clickScore = clickable ? Math.min(10, 4 + (style.cursor === 'pointer' ? 3 : 0) + (tagSet ? 2 : 0) + (role === 'button' ? 1 : 0) + (el.hasAttribute('onclick') ? 1 : 0)) / 10 : 0;
  return { visible, clickable, clickScore };
}

class DomReader {
  snapshot(root) {
    const r = root || getMainContentRoot();
    const nodes = [];
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT, null);
    let n;
    let styleReads = 0;
    let clickableCount = 0;
    while ((n = walker.nextNode())) {
      if (n === r) continue;
      const rect = n.getBoundingClientRect ? n.getBoundingClientRect() : null;
      const entry = {
        tag: n.tagName ? n.tagName.toLowerCase() : '',
        cls: typeof n.className === 'string' ? n.className.slice(0, 80) : '',
        id: n.id || '',
        text: (n.innerText || '').trim().slice(0, 200),
        textLen: (n.innerText || '').trim().length,
        rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
        visible: !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length),
        aria: n.getAttribute ? (n.getAttribute('aria-label') || '') : '',
        clickable: false,
        clickScore: 0
      };
      if (rect && styleReads < MAX_STYLE_READS_PER_SNAPSHOT && n.matches(CLICKABLE_CANDIDATE_SELECTOR)) {
        const s = scoreNode(n, entry.rect);
        styleReads++;
        entry.clickable = s.clickable;
        entry.clickScore = s.clickScore;
        if (s.clickable) clickableCount++;
      }
      nodes.push(entry);
      if (nodes.length > 5000) break;
    }
    return {
      ts: Date.now(),
      rootTag: r.tagName,
      // The root text is the last-resort answer source, so it has to be able to
      // hold a long response. `textLen` stays uncapped for the growth signals.
      text: r.innerText ? r.innerText.slice(0, 40000) : '',
      textLen: r.innerText ? r.innerText.length : 0,
      nodes,
      stats: {
        total: nodes.length,
        visible: nodes.filter(x => x.visible).length,
        clickable: clickableCount,
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

// --- Completion signals -----------------------------------------------------
// Gemini swaps the composer send button for a stop button while a turn is in
// flight and restores it when the turn ends. That toggle is the authoritative
// "the response is finished" signal: a settle timer cannot tell a real pause
// from a frozen page, but this can.
const SEND_WRAP_SELECTORS = 'gem-icon-button.send-button, .send-button';
const SEND_BTN_SELECTORS = 'gem-icon-button.send-button button, .send-button button';

function isGenerating() {
  // 1) The send button usually keeps its wrapper while the icon swaps to a
  //    stop glyph, so check the icon name on the wrapper first.
  const wrap = document.querySelector(SEND_WRAP_SELECTORS);
  if (wrap) {
    const icon = wrap.querySelector('[data-mat-icon-name]');
    if (icon && /stop/i.test(icon.getAttribute('data-mat-icon-name') || '')) return true;
  }
  // 2) A visible explicit stop control in the composer. Exact labels keep this
  //    from false-positiving on unrelated icons elsewhere in the document.
  const stop = document.querySelector(
    'button[aria-label="Stop response"], button[aria-label="Stop generating"], button[aria-label="Stop"]'
  );
  if (stop && stop.offsetParent !== null) return true;
  // 3) A disabled send button means the turn still owns the composer.
  const send = document.querySelector(SEND_BTN_SELECTORS);
  if (send && send.getAttribute('aria-disabled') === 'true') return true;
  return false;
}

// Text alone is not a render signal: the same characters can be re-laid-out
// while nodes mutate underneath (KaTeX swapping in math, syntax highlighting,
// lazy images). Fingerprint the node count too, so "finished" means the DOM
// itself settled and not merely that the string stopped growing.
function renderFingerprint(el) {
  if (!el) return '';
  const text = (el.textContent || '').trim();
  return text.length + ':' + el.querySelectorAll('*').length;
}

// Liveness beacon for the service worker. A slow-but-alive page keeps emitting
// this; a tab whose main thread is blocked goes completely silent, and that
// silence is the only reliable way to tell the two apart from outside the tab.
let lastBeatAt = 0;
function beat(extra) {
  const now = Date.now();
  if (now - lastBeatAt < 2000) return;
  lastBeatAt = now;
  try {
    chrome.runtime.sendMessage(Object.assign({ type: 'turn_heartbeat', ts: now }, extra || {}));
  } catch {
    /* worker asleep; the watchdog simply sees an older beat */
  }
}

class CompletionHeuristic {
  constructor(opts) {
    this.settleMs = (opts && opts.settleMs) || 3000;
    this.pollMs = (opts && opts.pollMs) || 500;
    this.snapshots = [];
    this.stableRun = 0;
    this.baselineCopyCount = 0;
    this.baselineClickableCount = 0;
    this.baselineTextLen = 0;
  }
  push(snap) {
    const prev = this.snapshots[this.snapshots.length - 1];
    if (prev) {
      // A gap much wider than the poll interval means the page was blocked and
      // we observed nothing during it, so that interval proves nothing about
      // whether the output stopped changing.
      if (snap.ts - prev.ts > this.pollMs * 3) this.stableRun = 0;
      else if (prev.text === snap.text) this.stableRun += 1;
      else this.stableRun = 0;
    }
    this.snapshots.push(snap);
    if (this.snapshots.length > 20) this.snapshots.shift();
  }
  setBaseline(snap) {
    this.baselineCopyCount = snap.nodes.filter(n => n.aria && /copy/i.test(n.aria) && n.visible).length;
    this.baselineClickableCount = snap.nodes.filter(n => n.clickable && n.aria && /copy|share|export|thumbs/i.test(n.aria)).length;
    this.baselineTextLen = snap.textLen;
  }
  hasNewCopySignal(snap) {
    const cur = snap.nodes.filter(n => n.aria && /copy/i.test(n.aria) && n.visible).length;
    return cur > this.baselineCopyCount;
  }
  hasNewClickableSignal(snap) {
    const cur = snap.nodes.filter(n => n.clickable && n.aria && /copy|share|export|thumbs/i.test(n.aria)).length;
    return cur > this.baselineClickableCount;
  }
  hasErrorSignal(snap) {
    return snap.nodes.some(n => n.aria && /error|alert/i.test(n.aria)) ||
           /something went wrong|failed to generate|you stopped this response/i.test(snap.text);
  }
  // Counted in observations that actually executed, not in elapsed
  // milliseconds. A long generation that pauses for seconds between chunks, or
  // a tab that freezes, produces one wide gap rather than a run of agreeing
  // samples, so it can no longer fake a completed turn.
  requiredSamples() { return Math.max(3, Math.ceil(this.settleMs / this.pollMs)); }
  textStable() { return this.stableRun >= this.requiredSamples(); }
  hasNewContent(snap) {
    return snap.textLen > this.baselineTextLen + 120;
  }
  isComplete(diff, snap) {
    if (this.hasErrorSignal(snap)) return { done: true, reason: 'error' };
    if (!this.hasNewContent(snap)) return { done: false, reason: 'waiting-content' };
    if (isGenerating()) return { done: false, reason: 'still-generating' };
    if (!this.textStable()) return { done: false, reason: 'waiting-stable' };
    if (this.hasNewCopySignal(snap)) return { done: true, reason: 'copy+stable' };
    if (this.hasNewClickableSignal(snap)) return { done: true, reason: 'clickable+stable' };
    if (diff && diff.stable) return { done: true, reason: 'stable' };
    return { done: true, reason: 'stable-samples' };
  }
}

// The selection rule lives in answer-root.js so it can be unit tested; see
// that file for why "biggest block" is the wrong answer here. Fall back to
// null if the helper was not loaded, which degrades to full page text.
function findAnswerRoot() {
  const api = (typeof globalThis !== 'undefined' && globalThis.__timepassAnswer) || null;
  return api ? api.findAnswerRoot(document) : null;
}

function readAnswerText(root) {
  const api = (typeof globalThis !== 'undefined' && globalThis.__timepassAnswer) || null;
  if (api) return api.readAnswerText(root);
  return root ? (root.textContent || '').trim().replace(/^Gemini said\s*/i, '').trim() : '';
}

// Choosing what a timeout may return is the same testable decision as choosing
// the answer root, so it lives in answer-root.js too. Without the helper the
// timeout path falls back to the first non-empty source, which is the old
// unlabelled-partial behaviour.
function timeoutOutcome(candidates) {
  const api = (typeof globalThis !== 'undefined' && globalThis.__timepassAnswer) || null;
  if (api) return api.timeoutOutcome(candidates);
  for (const c of candidates) {
    if (!c) continue;
    const text = (c.text || '').trim();
    if (text.length > (typeof c.minLength === 'number' ? c.minLength : 0)) {
      return { text, partial: true, source: c.source };
    }
  }
  return null;
}

class ResponseExtractor {
  extract(snap, prevSnap) {
    // Read the live DOM, never the snapshot's stored text: a snapshot node
    // keeps only the first 200 characters, so selecting the "largest" node out
    // of it returned a 200-character fragment of the real answer.
    const root = findAnswerRoot();
    const direct = readAnswerText(root);
    if (direct.length > 20) return direct;
    // Last resort: the page text. This includes surrounding chrome, but it is
    // complete, which beats a correct-looking fragment.
    let t = snap.text || '';
    t = t.replace(/^Gemini said\s*/i, '').replace(/Show code\s*/i, '').trim();
    // Strip user prompt echo
    const lines = t.split('\n').filter(l => l.trim());
    // Drop first lines that look like conversation header
    if (lines[0] && /Conversation with Gemini|You said/i.test(lines[0])) lines.shift();
    if (lines[0] && lines[0].length < 80 && prevSnap && prevSnap.text.includes(lines[0].slice(0, 30))) lines.shift();
    return lines.join('\n').trim() || t;
  }
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
  const heuristic = new CompletionHeuristic({ settleMs, pollMs });
  const extractor = new ResponseExtractor();

  function resolveNarrowEl() {
    const all = document.querySelectorAll(responseSelector);
    if (all.length === 0) return null;
    return responseSelectorStrategy === 'last' ? all[all.length - 1] : all[0];
  }

  // Pin the container created *after* send. Resolving it once at start-up
  // silently polls the previous turn whenever the chat already had an answer,
  // which returns the old reply; and on a fresh chat the new container may not
  // exist yet, which dropped us to the weaker broad path.
  const preSend = new Set(document.querySelectorAll(responseSelector));
  // One budget for the whole turn, not one per phase. The broad phase used to
  // start a fresh `timeoutMs` after the narrow phase had already spent up to
  // 45s, so a turn could occupy the page for nearly twice `timeoutMs` — long
  // after the caller had given up waiting and stopped listening. The caller
  // treats `timeoutMs` as the total, so the page has to treat it the same way.
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const narrowDeadline = startedAt + Math.min(timeoutMs, 45000);
  const STABLE_SAMPLES = Math.max(3, Math.ceil(settleMs / pollMs));
  const STALL_GAP_MS = Math.max(1500, pollMs * 3);

  let pinned = null;
  let lastFp = null;
  let lastText = '';
  let stableSamples = 0;
  let lastPollAt = 0;
  let sawGenerating = false;
  let maxGap = 0;

  function pinTarget() {
    const all = Array.from(document.querySelectorAll(responseSelector));
    // Only a container that did not exist before we sent is a candidate.
    // Falling back to a pre-send container here would hand back the previous
    // turn's answer as if it were the reply to this prompt.
    const fresh = all.find(el => !preSend.has(el));
    if (fresh) pinned = fresh;
    return pinned;
  }

  while (Date.now() < narrowDeadline) {
    await new Promise(r => setTimeout(r, pollMs));

    // A gap wider than the poll interval means the page was blocked and we
    // observed nothing during it, so it must not count as evidence that the
    // output stopped changing.
    const now = Date.now();
    const gap = lastPollAt ? now - lastPollAt : 0;
    if (gap > maxGap) maxGap = gap;
    lastPollAt = now;

    const el = pinTarget();
    const text = el ? (el.textContent || '').trim().replace(/^Gemini said\s*/i, '').trim() : '';
    const generating = isGenerating();
    if (generating) sawGenerating = true;

    if (text && text.length > lastText.length) {
      const delta = text.slice(lastText.length);
      lastText = text;
      try { chrome.runtime.sendMessage({ type: "stream_delta", delta, accumulatedText: text }); } catch (err) { console.warn('[Timepass] Failed to relay stream delta:', err); }
    }

    const fp = renderFingerprint(el);
    beat({ textLen: text.length, generating, gap });
    if (fp && fp === lastFp) {
      stableSamples = gap > STALL_GAP_MS ? 0 : stableSamples + 1;
    } else {
      stableSamples = 0;
    }
    lastFp = fp;

    // The stop button must have cleared. If it never appeared at all the signal
    // is unverified (Google markup drift), so wait longer rather than less.
    const required = sawGenerating ? STABLE_SAMPLES : STABLE_SAMPLES * 2;
    if (text && !generating && stableSamples >= required) {
      for (const sel of errorSelectors) {
        const e = el.querySelector(sel);
        if (e && e.innerText && e.innerText.trim()) throw new Error('Gemini error: ' + e.innerText.trim());
      }
      // Re-read after declaring done so the caller gets the freshest render
      // rather than the text captured when stability was first noticed.
      const finalText = (el.textContent || '').trim().replace(/^Gemini said\s*/i, '').trim();
      console.log('[Timepass] narrow done via', sawGenerating ? 'stop-button' : 'sample-count', '| stable', stableSamples, '| maxGap', maxGap, '| len', finalText.length);
      try { chrome.runtime.sendMessage({ type: "turn_complete", text: finalText, partial: false }); } catch (err) { console.warn('[Timepass] Failed to relay turn completion:', err); }
      return { text: finalText, partial: false, reason: sawGenerating ? 'stop-button' : 'sample-count' };
    }
  }

  let prevSnap = reader.snapshot();
  heuristic.push(prevSnap);
  heuristic.setBaseline(prevSnap);
  let streamedText = '';

  console.log('[Timepass] broad observeResponse start, baseline textLen', prevSnap.textLen, 'visible', prevSnap.stats.visible, 'baselineCopy', heuristic.baselineCopyCount);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const snap = reader.snapshot();
    const diff = differ.diff(prevSnap, snap);
    heuristic.push(snap);

    console.log('[Timepass] poll textLen', snap.textLen, 'delta', diff.textDelta, 'added', diff.added, 'changed', diff.changed, 'layout', diff.layoutShifts);

    const currentText = extractor.extract(snap, prevSnap);
    if (currentText && currentText.length > streamedText.length) {
      const delta = currentText.slice(streamedText.length);
      streamedText = currentText;
      try { chrome.runtime.sendMessage({ type: "stream_delta", delta, accumulatedText: streamedText }); } catch (err) { console.warn('[Timepass] Failed to relay stream delta:', err); }
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
      const finalText = extractor.extract(finalSnap, prevSnap);
      try { chrome.runtime.sendMessage({ type: "turn_complete", text: finalText, partial: false }); } catch (err) { console.warn('[Timepass] Failed to relay turn completion:', err); }
      return { text: finalText, partial: false, reason: c.reason };
    }
    prevSnap = snap;
  }
  // Timeout: the answer is unfinished. Returning the best text we have is
  // still better than throwing, but it is returned *labelled*, so no caller
  // downstream can mistake a fragment for a finished answer.
  console.log('[Timepass] broad observe timeout, returning extractor fallback');
  const finalSnap = reader.snapshot();
  const narrow = resolveNarrowEl();
  const outcome = timeoutOutcome([
    { source: 'extracted', text: extractor.extract(finalSnap, null), minLength: 10 },
    { source: 'response-container', text: narrow ? (narrow.textContent || narrow.innerText || '').replace(/^Gemini said\s*/i, '').trim() : '' }
  ]);
  if (!outcome) throw new Error('Timeout waiting for response completion');

  // Only relay the tail we had not already streamed, so the adapter's
  // accumulated text and this one agree.
  if (outcome.text.length > streamedText.length) {
    const delta = outcome.text.slice(streamedText.length);
    try { chrome.runtime.sendMessage({ type: "stream_delta", delta, accumulatedText: outcome.text }); } catch (err) { console.warn('[Timepass] Failed to relay stream delta:', err); }
  }
  console.warn('[Timepass] TIMED OUT after ' + timeoutMs + 'ms - returning PARTIAL answer (' + outcome.source + ', ' + outcome.text.length + ' chars)');
  try { chrome.runtime.sendMessage({ type: "turn_complete", text: outcome.text, partial: true, reason: 'timeout' }); } catch (err) { console.warn('[Timepass] Failed to relay turn completion:', err); }
  return { text: outcome.text, partial: true, reason: 'timeout' };
}

// Re-read the answer that Gemini already saved, used after the service worker
// reloads a frozen tab. Nothing is re-asked: the conversation is re-rendered
// from the server, so this returns the full response even though the live
// stream was cut off. Waits for the page to finish hydrating before trusting it.
async function recoverLastResponse(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  const pollMs = 500;
  const STABLE_SAMPLES = 6;
  let pinned = null;
  let lastFp = null;
  let stableSamples = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const all = document.querySelectorAll('response-container');
    if (all.length) pinned = all[all.length - 1];

    const text = pinned ? (pinned.textContent || '').trim().replace(/^Gemini said\s*/i, '').trim() : '';
    // No stream_delta here on purpose: the adapter appends deltas to whatever it
    // already collected before the freeze, so replaying the whole answer as a
    // delta would concatenate the partial text with the full one. The complete
    // text is delivered once, in turn_complete.

    const fp = renderFingerprint(pinned);
    if (fp && fp === lastFp) stableSamples += 1;
    else stableSamples = 0;
    lastFp = fp;
    beat({ textLen: text.length, generating: isGenerating(), recovering: true });

    // A freshly reloaded page usually has no stop button, but if Gemini shows
    // the turn is still running, keep waiting rather than returning a
    // half-rendered answer.
    if (text && stableSamples >= STABLE_SAMPLES && !isGenerating()) {
      const finalText = (pinned.textContent || '').trim().replace(/^Gemini said\s*/i, '').trim();
      console.log('[Timepass] recovered saved response | stable', stableSamples, '| len', finalText.length);
      try { chrome.runtime.sendMessage({ type: "turn_complete", text: finalText, recovered: true, partial: false }); } catch (err) { console.warn('[Timepass] Failed to relay recovered turn completion:', err); }
      return finalText;
    }
  }
  throw new Error('Reloaded the tab but the saved response never finished rendering.');
}

function RefMap() {
  this.elements = new Map();
}
RefMap.prototype.assign = function (map) {
  this.elements = new Map(map);
};
RefMap.prototype.resolve = function (index) {
  return this.elements.get(index) || null;
};
RefMap.prototype.resolveCenter = function (index) {
  const el = this.resolve(index);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
};
RefMap.prototype.invalidate = function () {
  this.elements.clear();
};

function timepassCleanAttrs(element) {
  const attrs = {};
  for (let i = 0; i < element.attributes.length; i++) {
    const value = element.attributes[i].value.trim();
    if (value) attrs[element.attributes[i].name] = value;
  }
  return attrs;
}
function timepassTextOf(element) {
  const t = (element.textContent || '').trim();
  return t.length ? t : null;
}
function timepassRootOf(element) {
  const doc = element.ownerDocument;
  return (doc && doc.documentElement) || element;
}
function timepassElementToDict(element, root) {
  const chain = [];
  let cur = element;
  while (cur && cur !== root) {
    chain.push(cur.tagName.toLowerCase());
    cur = cur.parentElement;
  }
  if (cur === root) chain.push(root.tagName.toLowerCase());
  chain.reverse();
  const parentEl = element.parentElement;
  let parent = null;
  if (parentEl) {
    parent = {
      tag: parentEl.tagName.toLowerCase(),
      cleanedAttributes: timepassCleanAttrs(parentEl),
      text: timepassTextOf(parentEl)
    };
  }
  const siblings = [];
  if (parentEl) {
    for (let i = 0; i < parentEl.children.length; i++) {
      if (parentEl.children[i] !== element) siblings.push(parentEl.children[i].tagName.toLowerCase());
    }
  }
  const children = [];
  for (let i = 0; i < element.children.length; i++) {
    children.push(element.children[i].tagName.toLowerCase());
  }
  return {
    tag: element.tagName.toLowerCase(),
    cleanedAttributes: timepassCleanAttrs(element),
    text: timepassTextOf(element),
    tagPath: chain,
    parent,
    siblings,
    children
  };
}
function timepassSeqRatio(a, b) {
  const A = Array.isArray(a) ? a.map(String) : a == null ? [] : Array.from(String(a));
  const B = Array.isArray(b) ? b.map(String) : b == null ? [] : Array.from(String(b));
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;
  if (A.length * B.length > 40000) {
    const freq = new Map();
    for (const token of A) freq.set(token, (freq.get(token) || 0) + 1);
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
  const dp = new Array(B.length + 1).fill(0);
  for (let i = 0; i < A.length; i++) {
    let prev = 0;
    for (let j = 0; j < B.length; j++) {
      const temp = dp[j + 1];
      if (A[i] === B[j]) dp[j + 1] = prev + 1;
      else dp[j + 1] = Math.max(dp[j], dp[j + 1]);
      prev = temp;
    }
  }
  return (2 * dp[B.length]) / (A.length + B.length);
}
function timepassDictRatio(d1, d2) {
  const k1 = Object.keys(d1);
  const k2 = Object.keys(d2);
  return timepassSeqRatio(k1, k2) * 0.5 + timepassSeqRatio(k1.map((k) => d1[k]), k2.map((k) => d2[k])) * 0.5;
}
function timepassSimilarityScore(original, node, root) {
  const data = timepassElementToDict(node, root);
  let score = 0;
  let checks = 0;
  score += original.tag === data.tag ? 1 : 0;
  checks++;
  if (original.text) {
    score += timepassSeqRatio(original.text, data.text || '');
    checks++;
  }
  score += timepassDictRatio(original.cleanedAttributes, data.cleanedAttributes);
  checks++;
  for (const attrib of ['class', 'id', 'href', 'src']) {
    const value = original.cleanedAttributes[attrib];
    if (value) {
      score += timepassSeqRatio(value, data.cleanedAttributes[attrib] || '');
      checks++;
    }
  }
  score += timepassSeqRatio(original.tagPath, data.tagPath);
  checks++;
  if (original.parent) {
    if (data.parent) {
      score += timepassSeqRatio(original.parent.tag, data.parent.tag);
      checks++;
      score += timepassDictRatio(original.parent.cleanedAttributes, data.parent.cleanedAttributes);
      checks++;
      if (original.parent.text) {
        score += timepassSeqRatio(original.parent.text, data.parent.text || '');
        checks++;
      }
    }
  }
  if (original.siblings.length) {
    score += timepassSeqRatio(original.siblings, data.siblings);
    checks++;
  }
  return checks ? score / checks : 0;
}

function AdaptiveStore() {
  this.domain = (window.location && window.location.hostname) || 'global';
}
AdaptiveStore.prototype.key = function (identifier) {
  return 'timepass:adaptive:' + this.domain + ':' + identifier;
};
AdaptiveStore.prototype.save = function (identifier, element) {
  if (!element) return;
  try {
    const data = timepassElementToDict(element, timepassRootOf(element));
    localStorage.setItem(this.key(identifier), JSON.stringify(data));
  } catch {
    return;
  }
};
AdaptiveStore.prototype.retrieve = function (identifier) {
  try {
    const raw = localStorage.getItem(this.key(identifier));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
AdaptiveStore.prototype.relocate = function (fingerprint, root, threshold) {
  if (!fingerprint || !root) return null;
  const t = threshold || 0.6;
  const nodes = [root].concat(Array.from(root.querySelectorAll('*')));
  let best = null;
  let bestScore = -1;
  for (const node of nodes) {
    const score = timepassSimilarityScore(fingerprint, node, root);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  return bestScore >= t ? best : null;
};

function ElementResolver(refMap, adaptive) {
  this.refMap = refMap;
  this.adaptive = adaptive || null;
}
ElementResolver.prototype.resolveFromSelectors = function (selectors) {
  for (const selector of selectors) {
    let el;
    try {
      el = document.querySelector(selector);
    } catch {
      continue;
    }
    if (el && (el.offsetParent !== null || el.getClientRects().length)) return el;
  }
  return null;
};
ElementResolver.prototype.resolveAdaptive = function (root) {
  if (!this.adaptive) return null;
  const fp = this.adaptive.retrieve('promptInput');
  return fp ? this.adaptive.relocate(fp, root) : null;
};

if (!window.__timepass_refMap) window.__timepass_refMap = new RefMap();
if (!window.__timepass_adaptiveStore) window.__timepass_adaptiveStore = new AdaptiveStore();
if (!window.__timepass_resolver) window.__timepass_resolver = new ElementResolver(window.__timepass_refMap, window.__timepass_adaptiveStore);

function findInputEditor() {
  const selectors = [
    "rich-textarea .ql-editor",
    "rich-textarea [contenteditable='true']",
    "[placeholder='Ask Gemini']",
    "textarea[placeholder*='Ask']",
    "div[contenteditable='true'][data-placeholder*='Ask']",
    "[aria-label*='Ask Gemini']",
    "[aria-label*='Prompt']",
    "div[role='textbox']",
    "rich-textarea > div > p",
    "div[contenteditable='true']"
  ];
  const editor = window.__timepass_resolver.resolveFromSelectors(selectors);
  if (editor) {
    window.__timepass_adaptiveStore.save('promptInput', editor);
    return editor;
  }
  const healed = window.__timepass_resolver.resolveAdaptive(document.body);
  if (healed) {
    window.__timepass_adaptiveStore.save('promptInput', healed);
    return healed;
  }
  return null;
}

// Typing simulation — handles both contenteditable and textarea/input
function simulateTyping(element, text) {
  return new Promise((resolve, reject) => {
    let current = element;
    current.focus();
    current.click();
    // Clear placeholder content
    if (current.tagName === 'TEXTAREA' || current.tagName === 'INPUT') {
      current.value = '';
      current.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // contenteditable: ensure empty
      if (current.innerText && current.innerText.trim() === 'Ask Gemini') current.textContent = '';
    }
    const chunkSize = 15;
    let i = 0;
    // Gemini rebuilds the composer while it takes focus, so the node captured
    // before typing is routinely stale a few keystrokes in. That used to abort
    // the whole turn even though the prompt was perfectly typeable — only our
    // handle on the box was out of date. Re-locate it and carry on.
    let relocations = 0;
    const MAX_RELOCATIONS = 5;
    const interval = setInterval(() => {
      if (!current.isConnected) {
        relocations++;
        if (relocations > MAX_RELOCATIONS) {
          clearInterval(interval);
          reject(new Error('Input editor kept being replaced while typing the prompt.'));
          return;
        }
        const fresh = findInputEditor();
        // No editor yet: wait for the next tick rather than giving up.
        if (!fresh) return;
        current = fresh;
        const api = (typeof globalThis !== 'undefined' && globalThis.__timepassAnswer) || null;
        i = api
          ? api.resumeTypingIndex(current.textContent, text.length)
          : (current.textContent || '').trim().length;
        return;
      }
      if (i >= text.length) {
        clearInterval(interval);
        current.dispatchEvent(new Event("input", { bubbles: true }));
        current.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
        resolve();
        return;
      }
      const chunk = text.slice(i, i + chunkSize);
      if (current.tagName === 'TEXTAREA' || current.tagName === 'INPUT') {
        current.value += chunk;
      } else {
        current.textContent += chunk;
        // For rich-textarea, also update inner p if present
        const p = current.querySelector('p');
        if (p) p.textContent += chunk;
      }
      current.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: chunk }));
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
    const sidebar = document.querySelector('aside, [class*="sidebar"], [class*="history-pane"]');
    const links = sidebar ? sidebar.querySelectorAll('a[href*="/app/"]') : [];
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
  const sidebar = document.querySelector('aside, [class*="sidebar"], [class*="history-pane"]');
  const links = sidebar ? sidebar.querySelectorAll('a[href*="/app/"]') : [];
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
          // Model switch disabled for iterative stability — re-enable after broad observer passes
          // const rawModel = payload && (payload.model || payload.modelId);
          await simulateTyping(editor, text);
          const btn = findSendButton();
          if (btn) {
            console.log("[Timepass] clicking send button");
            btn.click();
          } else {
            console.warn("[Timepass] send button NOT found after typing");
          }

          // Wait for response completion (copy button signal)
          const outcome = await observeResponse({
            settleMs: payload?.settleMs || 3000,
            timeoutMs: payload?.timeoutMs || 60000
          });

          sendResponse({
            success: true,
            turnComplete: true,
            text: outcome.text,
            partial: outcome.partial === true,
            chatId: window.location.href
          });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // keep message channel open for async
    }

    // Recovery path: the service worker reloads a frozen tab and asks the page
    // to re-read the response Gemini already saved, instead of re-asking.
    if (action === "recover_last_response") {
      (async () => {
        try {
          const text = await recoverLastResponse((payload && payload.timeoutMs) || 45000);
          sendResponse({ success: true, recovered: true, text, chatId: window.location.href });
        } catch (err) {
          sendResponse({ success: false, recovered: true, error: err.message });
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

    if (action === "dom_dump") {
      // The service worker forwards dom_dump to the page (see handleServerMessage
      // in background.js). serializeSubtree is declared at module scope below,
      // and the adapter reads this reply from its `result` field.
      sendResponse({
        success: true,
        result: serializeSubtree(payload?.selector, { maxDepth: payload?.maxDepth })
      });
      return;
    }

    if (action === "type_prompt") {
      const editor = findInputEditor();
      if (!editor) {
        sendResponse({ success: false, error: "Input editor not found" });
        return;
      }
      if (!payload || !payload.text) {
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
