// Timepass Gemini Extension - Content Script (gemini.google.com)

// ===== WHOLE-FILE IDEMPOTENCY GUARD =====
// The body below is deliberately NOT re-indented. Wrapping 1100+ lines in a
// block would bury the actual change under whitespace and make the diff
// unreviewable; JavaScript does not care, and the guard is what matters.

// This file is a *classic* script, not a module. A second evaluation into the
// same document re-enters the SAME global lexical environment, so every
// top-level `const`/`let`/`class` in this file collides with the one left by
// the previous evaluation and throws
//   SyntaxError: Identifier 'CLICKABLE_CANDIDATE_SELECTOR' has already been declared
// at PARSE time -- which kills the entire file, including the listener guard at
// the bottom. Re-injection could therefore never succeed, by construction.
// The service worker's own "reset the flag, then re-inject" path hits exactly
// this: the flag it resets sits *below* the parse-time failure.
//
// Two properties are needed and neither is sufficient alone:
//   * the IIFE gives every declaration its own function scope, so a second
//     evaluation cannot collide even if the flag check were somehow bypassed;
//   * the early return makes a second injection a genuine no-op, so the console
//     interceptor is not wrapped twice (which would double every log line) and
//     the message listener is not registered twice.
(function () {
  if (window.__timepass_content_loaded) return;
  window.__timepass_content_loaded = true;

  try {

  // ===== ONE-TIME SETUP =====
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

// (the vestigial __timepass_activeMutationObserver flag that used to sit here
// was written and read nowhere else in the repo; it is dropped rather than
// carried inside the new guard.)

// ========== BROAD DOM READER ENGINE (site-agnostic) ==========

function getMainContentRoot() {
  const candidates = ['main', '[role="main"]', '.conversation-container', '#chat-container', '.chat-history', 'response-container'];
  for (const sel of candidates) {
    // FLAT FIRST, shadow fallback (#12 robustness, unverified). This is the
    // scan root for the whole DOM-diff engine, so a page whose main region is
    // shadow-hosted would otherwise snapshot an empty body.
    const el = deepQueryAll(sel)[0] || null;
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
const STOP_BTN_SELECTORS =
  'button[aria-label="Stop response"], button[aria-label="Stop generating"], button[aria-label="Stop"]';

// --- Generation state -------------------------------------------------------
//
// THREE states, not a boolean. A boolean forces "I cannot see the composer" to
// be reported as "not generating", and the narrow loop then ends the turn on the
// settle heuristic alone. Gemini pauses between tokens and between tool steps,
// so any pause long enough to cross the stability threshold truncates the
// answer -- and reports it as complete, which is worse than a wrong error.
// Absence of evidence is not evidence of absence, so 'unknown' is its own state
// and the loops refuse to finish a turn on it. Worst case becomes a LABELLED
// partial answer, which is honest.
//
// ROBUSTNESS, NOT A BUG FIX (#12). The shadow-root premise this defends against
// is UNVERIFIED and the evidence now leans against it: two captured DOM
// transcripts contain zero shadow roots in total, and the `gem-button` /
// `mat-menu` elements once cited as proof carry Angular `_nghost-*` attributes,
// which is what EMULATED encapsulation emits -- emulated encapsulation renders
// into light DOM and creates no shadow root at all. So the deep queries below
// are a flat-first-with-fallback, not a correction of anything observed broken.
// Settle it in the live tab:
//   document.querySelectorAll('gem-icon-button').length
//   document.querySelectorAll('response-container').length
// If both are non-zero, the deep lookups are harmless belt-and-braces and #12
// should be closed as a non-issue.

const GENERATION_UNKNOWN = 'unknown';

function generationState() {
  let sawComposer = false;

  // 1) The send button usually keeps its wrapper while the icon swaps to a stop
  //    glyph, so check the icon name on the wrapper first.
  //    FLAT FIRST, shadow fallback: deepQueryAll queries light DOM before it
  //    looks at any shadow root, so this is a strict superset of the old query.
  const wrap = deepQueryAll(SEND_WRAP_SELECTORS)[0] || null;
  if (wrap) {
    sawComposer = true;
    // A DESCENT rather than a query from outside: the icon may sit one level
    // into wrap's own shadow root, which wrap.querySelector() cannot cross.
    const icon = descendantsDeep(wrap, '[data-mat-icon-name]', false)[0] || null;
    if (icon && /stop/i.test(icon.getAttribute('data-mat-icon-name') || '')) return 'generating';
  }

  // 2) A visible explicit stop control in the composer. Exact labels keep this
  //    from false-positiving on unrelated icons elsewhere in the document.
  //    Visibility uses isRendered, NOT `offsetParent !== null`: per the CSSOM
  //    spec offsetParent is null for position:fixed elements, so a fixed stop
  //    button reads as invisible. That blind spot is confirmed at source level
  //    and does not depend on the shadow question at all.
  const stop = deepQueryAll(STOP_BTN_SELECTORS)[0] || null;
  if (stop) {
    sawComposer = true;
    if (isRendered(stop)) return 'generating';
  }

  // 3) A disabled send button means the turn still owns the composer.
  const send = deepQueryAll(SEND_BTN_SELECTORS)[0] || null;
  if (send) {
    sawComposer = true;
    if (send.getAttribute('aria-disabled') === 'true') return 'generating';
  }

  // Nothing in the composer was reachable at all: we do not know whether the
  // turn is running, and must not report that as "finished".
  return sawComposer ? 'idle' : GENERATION_UNKNOWN;
}

/**
 * @returns {boolean} True only when generation is POSITIVELY detected. Anything
 * needing to distinguish "idle" from "unknown" must use generationState().
 */
function isGenerating() {
  return generationState() === 'generating';
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
//
// EVERY wait that can outlast the watchdog's silence window must call this. A
// turn that stops emitting looks exactly like a frozen tab, and the worker's
// response to that is to reload the page -- destroying a live answer and forcing
// the fragile recovery path. That is not theoretical: the broad fallback loop
// used to go silent here for every turn past narrowDeadline, which is why every
// long ask took a ~60s watchdog detour.
//
// `phase` is required rather than optional: it makes the telemetry self-
// describing, so a silence window can be attributed to a polling phase instead
// of being guessed at from the surrounding log lines.
let lastBeatAt = 0;
function beat(phase, extra) {
  const now = Date.now();
  if (now - lastBeatAt < 2000) return;
  lastBeatAt = now;
  try {
    chrome.runtime.sendMessage(Object.assign({ type: 'turn_heartbeat', ts: now, phase }, extra || {}));
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
    // 'idle' rather than !isGenerating(), for the same reason as the narrow
    // loop: an unseen composer is not evidence that the turn finished.
    if (generationState() !== 'idle') return { done: false, reason: 'still-generating' };
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
    // FLAT FIRST, shadow fallback (#12 robustness, unverified). deepQueryAll
    // queries light DOM before any shadow root, so this is a strict superset.
    const all = deepQueryAll(responseSelector);
    if (all.length === 0) return null;
    return responseSelectorStrategy === 'last' ? all[all.length - 1] : all[0];
  }

  // Pin the container created *after* send. Resolving it once at start-up
  // silently polls the previous turn whenever the chat already had an answer,
  // which returns the old reply; and on a fresh chat the new container may not
  // exist yet, which dropped us to the weaker broad path.
  // Must see the SAME node set as pinTarget() below, or "a container created
  // after we sent" degenerates into "the first container we happen to see" and
  // hands back the previous turn's answer.
  const preSend = new Set(deepQueryAll(responseSelector));
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
  // Diagnostics: did we ever see the composer during this turn? If never, the
  // composer was unfindable throughout and any completion reached here rests on
  // the settle heuristic alone.
  let sawComposer = false;
  let maxGap = 0;

  function pinTarget() {
    const all = descendantsDeep(document.body, responseSelector, false);
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
    // Three-state on purpose: `generating` alone cannot tell "finished" apart
    // from "the composer is invisible to us", and only the first of those is a
    // reason to stop waiting.
    const genState = generationState();
    const generating = genState === 'generating';
    if (generating) sawGenerating = true;
    if (genState !== GENERATION_UNKNOWN) sawComposer = true;

    if (text && text.length > lastText.length) {
      const delta = text.slice(lastText.length);
      lastText = text;
      try { chrome.runtime.sendMessage({ type: "stream_delta", delta, accumulatedText: text }); } catch (err) { console.warn('[Timepass] Failed to relay stream delta:', err); }
    }

    const fp = renderFingerprint(el);
    beat('narrow', { textLen: text.length, generating, genState, gap });
    if (fp && fp === lastFp) {
      stableSamples = gap > STALL_GAP_MS ? 0 : stableSamples + 1;
    } else {
      stableSamples = 0;
    }
    lastFp = fp;

    // The stop button must have cleared. If it never appeared at all the signal
    // is unverified (Google markup drift), so wait longer rather than less.
    const required = sawGenerating ? STABLE_SAMPLES : STABLE_SAMPLES * 2;
    // `genState === 'idle'` rather than `!generating`: an UNKNOWN composer must
    // not end a turn, because that is how an answer gets truncated and reported
    // as complete. The deadline still applies, so the worst case is a labelled
    // partial rather than a silent truncation.
    if (text && genState === 'idle' && stableSamples >= required) {
      for (const sel of errorSelectors) {
        const e = el.querySelector(sel);
        if (e && e.innerText && e.innerText.trim()) throw new Error('Gemini error: ' + e.innerText.trim());
      }
      // Re-read after declaring done so the caller gets the freshest render
      // rather than the text captured when stability was first noticed.
      const finalText = (el.textContent || '').trim().replace(/^Gemini said\s*/i, '').trim();
      // sawComposer is a diagnostic, not a gate: it answers "did we ever actually
      // see the composer during this turn?". If it is false, the generation
      // signal was blind throughout and this completion rested on the settle
      // heuristic alone -- the exact condition issue #12 is about.
      console.log('[Timepass] narrow done via', sawGenerating ? 'stop-button' : 'sample-count', '| stable', stableSamples, '| maxGap', maxGap, '| sawComposer', sawComposer, '| len', finalText.length);
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

    // THE heartbeat this loop was missing. Without it, every turn that outlived
    // narrowDeadline went completely silent while perfectly healthy, and the
    // worker read that silence as a frozen tab and reloaded the page mid-answer.
    // Any loop that waits on the page owes the worker a beat.
    beat('broad', {
      textLen: snap.textLen,
      generating: isGenerating(),
      genState: generationState(),
      elapsedMs: Date.now() - startedAt,
    });

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
    // FLAT FIRST, shadow fallback. If this ever returns nothing the loop runs
    // to its deadline and throws "never finished rendering" -- indistinguishable
    // from Gemini genuinely never answering, which feeds straight into #3 and #5.
    const all = deepQueryAll('response-container');
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
    beat('recovering', { textLen: text.length, generating: isGenerating(), recovering: true });

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
      // FLAT FIRST, shadow fallback. The composer is a custom-element stack in
      // the same family as the rest of the UI; if any part of it is ever not
      // reachable flat, this is what stops the turn failing with "Input editor
      // not found" before a single character is typed.
      el = deepQueryAll(selector)[0] || null;
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
      // The worker arms its freeze watchdog the moment it dispatches
      // inject_and_send, which is BEFORE any of this typing happens. A long
      // prompt takes 15 chars per tick, so without a beat here the page is
      // silent for the whole typing phase and a healthy long ask can look
      // frozen before the response loop has even started.
      beat('typing', { typedChars: i, promptLen: text.length });

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
    const btn = deepQueryAll(sel)[0] || null;
    if (btn) return btn;
  }
  return null;
}

// --- Conversation history (sidebar) -----------------------------------------
//
// The extension drives a PINNED BACKGROUND TAB, where Gemini collapses the
// history sidebar by default. Collapsed means there are no `a[href*="/app/"]`
// nodes at all, so the old read returned an empty list -- indistinguishable
// from a user who genuinely has no conversations. `gemini_history` then said
// "no conversations" while three existed.
//
// Two rules make the failure visible instead of silent:
//   1. read the sidebar only after it has been opened (re-querying AFTER the
//      click, never returning the pre-click snapshot); and
//   2. if the sidebar cannot be confirmed open, return an ERROR carrying
//      diagnostics -- never an empty `history` array.

const SIDEBAR_CONTAINER_SELECTORS = [
  'aside',
  '[class*="sidebar"]',
  '[class*="history-pane"]',
  'mat-sidenav',
  '[role="navigation"]',
];

// Labels that mean "show me the side panel". Matched against the accessible
// name, not a hardcoded selector, because this is obfuscated Angular markup
// that changes without notice.
const SIDEBAR_TOGGLE_NAME = /(open|expand|show|menu|chats|history|conversation)/i;

const HISTORY_PROBE_TIMEOUT_MS = 3000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isRendered(el) {
  if (!el) return false;
  return el.offsetParent !== null || (typeof el.getClientRects === 'function' && el.getClientRects().length > 0);
}

function accessibleName(el) {
  if (!el) return '';
  return (el.getAttribute('aria-label') || el.getAttribute('title') ||
          el.getAttribute('mattooltip') || (el.textContent || '')).trim();
}

// --- Shadow-aware lookup ----------------------------------------------------
//
// Live page inspection during the #8 work found `gem-button` / `mat-menu`
// elements that a page-context querySelectorAll cannot see, which means parts
// of this UI sit behind open shadow roots. It is not established that the
// history sidebar itself does, but flat querying is demonstrably unreliable
// here, so every lookup below searches light DOM *and* open shadow roots.
// If the sidebar turns out to be flat, this costs a little and changes nothing.

let shadowCache = null;

function shadowRootsWithin(root) {
  const roots = [];
  const walk = node => {
    const all = node.querySelectorAll ? node.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
    }
  };
  walk(root);
  return roots;
}

/**
 * Every open shadow root on the page. Cached briefly because this is reached
 * from a 100ms poll loop and a full walk of a heavy SPA on every tick is not
 * acceptable; the UI settles well inside the TTL.
 */
function pageShadowRoots() {
  const now = Date.now();
  if (shadowCache && now - shadowCache.at < 1000) return shadowCache.roots;
  const roots = shadowRootsWithin(document.body);
  shadowCache = { at: now, roots };
  return roots;
}

/** querySelectorAll across light DOM and every open shadow root, de-duplicated. */
function deepQueryAll(selector) {
  const out = [];
  const push = n => { if (out.indexOf(n) === -1) out.push(n); };
  const light = document.querySelectorAll ? document.querySelectorAll(selector) : [];
  for (const n of light) push(n);
  for (const root of pageShadowRoots()) {
    const found = root.querySelectorAll(selector);
    for (const n of found) push(n);
  }
  return out;
}

/**
 * The same search, but rooted at an element instead of the document.
 *
 * Needed because a piercing query alone does NOT cover querying INTO an
 * element: `wrap.querySelector(x)` cannot cross wrap's own shadow boundary, so
 * a descendant one level of shadow down is invisible no matter how the outer
 * query was done. Descendant lookup therefore has to be a descent that steps
 * through shadow roots as it goes.
 */
function descendantsDeep(root, selector, includeSelf) {
  const out = [];
  const push = n => { if (out.indexOf(n) === -1) out.push(n); };
  if (includeSelf && root && root.matches && root.matches(selector)) push(root);
  const walk = node => {
    if (!node || !node.querySelectorAll) return;
    const found = node.querySelectorAll(selector);
    for (const n of found) push(n);
    // The node itself may be a shadow host. Checking only its children misses
    // exactly the case that matters here -- querying INTO a `gem-icon-button`
    // whose icon lives in that button's OWN shadow root.
    if (node.shadowRoot) walk(node.shadowRoot);
    const all = node.querySelectorAll('*');
    for (const el of all) {
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(root);
  return out;
}

function findSidebarContainer() {
  for (const sel of SIDEBAR_CONTAINER_SELECTORS) {
    const found = deepQueryAll(sel);
    if (found.length) return found[0];
  }
  return null;
}

/**
 * Conversation links. Scoped to the sidebar when one can be identified, and
 * searched through shadow roots either way. Falls back to the whole document
 * so a selector drift in the container does not silently yield zero results.
 */
function conversationLinks() {
  const sidebar = findSidebarContainer();
  if (sidebar) {
    const inSidebar = [];
    const push = n => { if (inSidebar.indexOf(n) === -1) inSidebar.push(n); };
    const light = sidebar.querySelectorAll('a[href*="/app/"]');
    for (const n of light) push(n);
    for (const root of shadowRootsWithin(sidebar)) {
      const found = root.querySelectorAll('a[href*="/app/"]');
      for (const n of found) push(n);
    }
    if (inSidebar.length) return inSidebar;
  }
  return deepQueryAll('a[href*="/app/"]');
}

/** The control that opens the sidebar, or null. */
function findSidebarToggle() {
  // Preferred: something that declares its own expanded state.
  const declared = deepQueryAll(
    '[aria-expanded], [aria-controls*="sidenav" i], mat-sidenav [aria-label], button[aria-label]'
  );
  const candidates = declared.concat(deepQueryAll('button, [role="button"], mat-icon-button'));

  for (const el of candidates) {
    if (!isRendered(el)) continue;
    const name = accessibleName(el);
    if (name && SIDEBAR_TOGGLE_NAME.test(name) && el.getAttribute('aria-expanded') !== 'true') {
      return el;
    }
  }
  return null;
}

/** Can we positively tell the sidebar is open even if it holds no links? */
function sidebarIsConfirmedOpen() {
  return deepQueryAll('[aria-expanded="true"], mat-sidenav[opened], [aria-expanded="true"] mat-sidenav').length > 0;
}

function sidebarDiagnostics() {
  const sidebar = findSidebarContainer();
  const buttons = deepQueryAll('button, [role="button"], mat-icon-button');
  const labels = [];
  for (let i = 0; i < buttons.length && labels.length < 12; i++) {
    const name = accessibleName(buttons[i]);
    if (name) labels.push(name.slice(0, 60));
  }
  return {
    sidebarContainerFound: !!sidebar,
    sidebarSelector: sidebar ? (sidebar.tagName || '').toLowerCase() : null,
    toggleFound: !!findSidebarToggle(),
    linkCount: conversationLinks().length,
    buttonLabels: labels,
  };
}

/**
 * Open the history sidebar if it is closed.
 * @returns {Promise<{ok: boolean, reason?: string, diagnostics?: object, confirmedEmpty?: boolean}>}
 */
async function ensureSidebarExpanded(options) {
  const timeoutMs = (options && options.timeoutMs) || HISTORY_PROBE_TIMEOUT_MS;
  if (conversationLinks().length > 0) return { ok: true, reason: 'already-open' };

  const toggle = findSidebarToggle();
  if (!toggle) {
    // No control to click: we cannot claim the list is empty, because we never
    // managed to look inside.
    return { ok: false, reason: 'no-toggle-found', diagnostics: sidebarDiagnostics() };
  }

  toggle.click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(100);
    if (conversationLinks().length > 0) return { ok: true, reason: 'expanded' };
  }

  // Clicked, waited, still nothing. If the DOM positively reports the sidebar as
  // open then the user really has no conversations; otherwise we simply could
  // not read it, and that must not masquerade as an empty history.
  if (sidebarIsConfirmedOpen()) return { ok: true, reason: 'expanded-but-empty', confirmedEmpty: true };
  return { ok: false, reason: 'no-links-after-expand', diagnostics: sidebarDiagnostics() };
}

function historyItemsFrom(links) {
  const items = [];
  const seen = new Set();
  for (const link of links) {
    const url = link.href;
    const title = (link.textContent || "").trim();
    if (!url || seen.has(url)) continue;
    if (!title && url.endsWith("/app")) continue;
    seen.add(url);
    items.push({ title: title || url, url });
  }
  return items;
}

// Read conversation history, opening the sidebar first if it is collapsed.
async function readHistory(payload) {
  try {
    const res = await ensureSidebarExpanded(payload);
    if (!res.ok) {
      return {
        success: false,
        error: 'Could not read Gemini conversation history: the sidebar could not be opened (' +
               res.reason + '). Refusing to report an empty history, because an unreadable ' +
               'sidebar is indistinguishable from an empty one.',
        diagnostics: res.diagnostics,
      };
    }
    const history = historyItemsFrom(conversationLinks());
    return { success: true, history, sidebarState: res.reason, confirmedEmpty: history.length === 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Select a conversation by title or url. Opens the sidebar itself, so it works
// standalone without a prior read_history call.
async function selectHistory(target) {
  const title = (target && target.title || "").trim().toLowerCase();
  const url = target && target.url;
  if (!title && !url) {
    return { success: false, error: "History item not found: (no target)" };
  }
  try {
    const res = await ensureSidebarExpanded(target);
    if (!res.ok) {
      return {
        success: false,
        error: 'Could not open Gemini conversation history (' + res.reason + '), so "' +
               (title || url) + '" could not be matched.',
        diagnostics: res.diagnostics,
      };
    }
    const links = conversationLinks();
    for (const link of links) {
      const matchTitle = title && (link.textContent || "").trim().toLowerCase().includes(title);
      const matchUrl = url && link.href === url;
      if (matchTitle || matchUrl) {
        link.click();
        return { success: true, url: link.href };
      }
    }
    return { success: false, error: "History item not found: " + (title || url || "(no target)") };
  } catch (err) {
    return { success: false, error: err.message };
  }
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
          // Conforms to CompletedAnswerEnvelope in src/adapter/types.ts. This
          // producer used to omit `turnComplete`, which is the one shape the
          // adapter classifies as a failure -- so a fully recovered answer was
          // thrown away and the user got an error instead of it. The adapter now
          // tolerates the legacy shape, but every producer is expected to
          // conform; see issue #5.
          sendResponse({
            success: true,
            turnComplete: true,
            recovered: true,
            text,
            chatId: window.location.href,
          });
        } catch (err) {
          // A failed recovery is NOT a completed answer: there is no text and
          // the turn did not finish, so this must not claim turnComplete. It
          // stays flagged `recovered` to say which path produced the failure.
          sendResponse({ success: false, recovered: true, error: err.message });
        }
      })();
      return true; // keep message channel open for async
    }

    // Both of these are async because opening the sidebar means clicking a control
// and waiting for the list to render. They MUST return true: a listener that
// returns undefined closes the message channel immediately, and the response
// would be discarded as "no receiver". This is the single most likely way to
// break these tools again -- see issue #7.
if (action === "read_history") {
      readHistory(payload)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // keep message channel open for async
    }

    if (action === "select_history") {
      selectHistory(payload)
        .then(sendResponse)
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true; // keep message channel open for async
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
      return;
    }

    if (action === "get_status") {
      sendResponse({
        success: true,
        url: window.location.href,
        hasInput: !!findInputEditor()
      });
      return;
    }

    if (action === "click_button") {
      try {
        // KNOWN LIMIT (#12), deliberately NOT changed to a deep query.
        //
        // Every other lookup in this file searches light DOM first and then open
        // shadow roots. This one is different: it takes a caller-supplied
        // selector, and a piercing fallback here would silently change WHICH
        // element gets clicked when a selector matches more than one node in
        // different roots. A generic "click this CSS selector" action is also
        // fundamentally ambiguous across roots -- there is no single answer to
        // "the button matching X" when X exists in several trees.
        //
        // So: flat only, and it fails loudly with the selector rather than
        // guessing. A shadow-aware version wants to be a separate action whose
        // contract is defined deliberately (e.g. take a DOM path, or an index
        // into a documented deep query), not a quiet widening of this one.
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
      return;
    }

    if (action === "get_page_info") {
      sendResponse({
        success: true,
        url: window.location.href,
        title: document.title,
        // DEEP, not flat. These are diagnostics, and a flat count is a
        // misleading one: "file inputs: 0" during the #8 work was read as
        // "the page has no file input" when it only meant "not reachable from
        // the light DOM". Counting through shadow roots makes the number mean
        // what it says. Confirmed defect, independent of the #12 hypothesis.
        fileInputs: deepQueryAll("input[type='file']").length,
        dropzones: deepQueryAll("[xapfileselectordropzone]").length,
        buttons: deepQueryAll("button").length,
        shadowRootCount: pageShadowRoots().length
      });
      return;
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

  // FLAT FIRST, shadow fallback, so a dom_dump can root inside a shadow root.
  const root = rootSelector ? (deepQueryAll(rootSelector)[0] || null) : document.body;
  if (!root) return { ok: false, error: `Selector matched nothing: ${rootSelector}` };
  return { ok: true, url: location.href, title: document.title, tree: walk(root, 0) };
}

  } catch (err) {
    // A half-installed script must not permanently block the retry path. If the
    // body threw, drop BOTH flags so the next injection starts from scratch
    // rather than finding a world marked "loaded" that never got its listener.
    delete window.__timepass_content_loaded;
    delete window.__timepass_listener_registered;
    throw err;
  }
})();
