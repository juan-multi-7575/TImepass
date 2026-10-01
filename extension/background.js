// Timepass Gemini Extension - Background Service Worker

let ws = null;
let reconnectAttempts = 0;
const MAX_BACKOFF_MS = 30000; // 30s max
// The 2s poll schedules a new, independent timer on every tick while offline.
// Without this handle the backoff saturates at 30s within five ticks while new
// 30s timers keep being queued, so the extension opens a pile of orphaned
// sockets. Clear before scheduling so only one reconnect is ever in flight.
let reconnectTimer = null;

// Remote console log interceptor for background service worker
(() => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;

  const LOG_RATE_LIMIT = 20;
  let logCount = 0;
  let logWindowStart = Date.now();

  function sendRemoteLog(level, args) {
    try {
      const now = Date.now();
      if (now - logWindowStart >= 1000) {
        logCount = 0;
        logWindowStart = now;
      }

      if (logCount >= LOG_RATE_LIMIT) return;
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

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "extension_log",
          source: "background",
          level: level,
          text: text
        }));
      }
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
})();
const WS_PORT = 9876;
const TAB_GROUP_TITLE = "🤖 Timepass Gemini";
const TAB_GROUP_COLOR = "purple";

// Maintain WebSocket connection to timepass server
async function connectWebSocket() {
  if (ws) {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      return;
    }
    ws = null;
  }

  // Pre-flight check: Probe localhost port silently to check if timepass server is running
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    await fetch(`http://127.0.0.1:${WS_PORT}`, { mode: "no-cors", signal: controller.signal });
    clearTimeout(timer);
  } catch {
    // Server is offline; set status silently without throwing extension error
    chrome.storage.local.set({ status: "offline" });
    return;
  }

  // Server is active; establish WebSocket connection
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);

    socket.onopen = () => {
      console.log("[Timepass MV3] Connected to local timepass WebSocket server.");
      reconnectAttempts = 0;
      chrome.storage.local.set({ status: "connected", lastConnected: Date.now() });
      // Introduce ourselves only once the socket is genuinely open, so the
      // announcement cannot be lost to a not-yet-open channel.
      sendBridgeHello();
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleServerMessage(message);
      } catch (err) {
        console.error("[Timepass MV3] Error parsing message:", err);
      }
    };

    socket.onerror = () => {
      chrome.storage.local.set({ status: "disconnected" });
    };

    socket.onclose = () => {
      chrome.storage.local.set({ status: "disconnected" });
      if (ws === socket) {
        ws = null;
      }
    };

    ws = socket;
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    chrome.storage.local.set({ status: "disconnected", lastError: errMsg });
    ws = null;
  }
}

/**
 * Announce which build is actually running and what it can dispatch.
 *
 * `buildId` is read from the manifest rather than hardcoded, because the whole
 * value of this message is that it comes from the worker that is really
 * executing: a worker still holding pre-edit code reports the old id, and that
 * mismatch is the signal the operator needs.
 */
function sendBridgeHello() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({
      type: "bridge_hello",
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      buildId: runningBuildId(),
      actions: KNOWN_ACTIONS,
      asyncActions: [...ASYNC_ACTIONS]
    }));
  } catch (err) {
    console.warn("[Timepass MV3] Could not send the bridge handshake:", err);
  }
}

/**
 * React to the host's introduction. Purely advisory: a mismatch changes nothing
 * about behaviour, it only becomes visible. Silence here is what let a stale
 * worker look healthy for a whole retest, so the signal is pushed three ways --
 * the console, a toolbar badge the operator cannot miss, and a message back to
 * the host so it lands in the tool output instead of a devtools window nobody
 * has open.
 */
function handleBridgeHello(message) {
  const mine = runningBuildId();
  const expected = message.expectedExtensionBuildId;
  const problems = [];

  if (typeof expected === "string" && expected && mine && expected !== mine) {
    problems.push(
      `build mismatch: the host expects extension build ${expected} but this worker is running ${mine}. ` +
      'The worker is running code that is not on disk — reload it at chrome://extensions → Reload, ' +
      'then restart the DSH session.'
    );
  }

  if (Array.isArray(message.knownActions)) {
    const unsupported = message.knownActions.filter(action => !KNOWN_ACTIONS.includes(action));
    if (unsupported.length) {
      problems.push(
        `the host will send ${unsupported.length} action(s) this build cannot handle: ` +
        `${unsupported.join(", ")}. Reload the extension at chrome://extensions → Reload.`
      );
    }
  }

  if (problems.length) {
    const summary = problems.join(" | ");
    console.warn(`[Timepass MV3] Bridge handshake problem: ${summary}`);
    // Tell the host, so the mismatch shows up in the tool output.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "bridge_mismatch", message: summary }));
      } catch (err) {
        console.warn("[Timepass MV3] Could not report the handshake mismatch:", err);
      }
    }
    // And badge the toolbar: red "!" until the operator reloads.
    try {
      chrome.action.setBadgeBackgroundColor({ color: "#d73a4a" });
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setTitle?.({ title: `Timepass: ${summary}` });
    } catch { /* the action API is best-effort decoration */ }
  } else {
    // Agreement clears any stale warning, so the badge cannot outlive the fix.
    try {
      chrome.action.setBadgeText({ text: "" });
      chrome.action.setTitle?.({ title: "Timepass Gemini" });
    } catch { /* best-effort */ }
  }
}

// --- Tab selection and load-wait ---------------------------------------------
// The bridge drives ONE Gemini tab, but the operator may have several: the
// pinned one we create, plus any they opened by hand, plus tabs a watchdog
// reload left behind. `chrome.tabs.query` makes no ordering promise, so the old
// `tabs[0]` could adopt a discarded tab (whose content script is gone) or the
// operator's foreground tab. Both are avoidable, so rank explicitly.
const TAB_LOAD_BUDGET_MS = 30000;
const TAB_LOAD_POLL_MS = 250;

/**
 * Is this tab usable right now? `discarded` is checked explicitly rather than
 * inferred from `status`: a discarded tab keeps its URL and can still report
 * `status: "complete"`, so a status-only test would wave a dead tab through.
 */
function tabIsReady(tab) {
  return !!tab &&
    tab.status === "complete" &&
    !tab.discarded &&
    typeof tab.url === "string" &&
    tab.url.includes("gemini.google.com");
}

/** Order two candidate tabs, best first. Pure, so it is directly testable. */
function compareGeminiTabs(a, b) {
  // A live tab always beats a discarded one.
  if (!!a.discarded !== !!b.discarded) return a.discarded ? 1 : -1;
  // Then a finished load beats one still in flight.
  if (tabIsReady(a) !== tabIsReady(b)) return tabIsReady(a) ? -1 : 1;
  // Then our own pinned tab, which is the one we keep warm on purpose.
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  // Then leave the operator's foreground tab alone.
  if (!!a.active !== !!b.active) return a.active ? 1 : -1;
  // Finally the most recently used.
  const la = typeof a.lastAccessed === "number" ? a.lastAccessed : -1;
  const lb = typeof b.lastAccessed === "number" ? b.lastAccessed : -1;
  return lb - la;
}

/** Pick the best Gemini tab from a query result, or null when there are none. */
function pickGeminiTab(tabs) {
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return tabs.slice().sort(compareGeminiTabs)[0];
}

/** Truthful description of a tab for an error message. */
function describeTabState(tab) {
  if (!tab) return "no tab (resolution failed before a tab was obtained)";
  const flags = [`status=${tab.status}`];
  if (tab.discarded) flags.push("discarded");
  if (tab.active) flags.push("active");
  if (tab.pinned) flags.push("pinned");
  return `tab ${tab.id} at ${tab.url || "(no url)"} [${flags.join(", ")}]`;
}

// Ensure Gemini tab exists and is in the "Timepass Gemini" Tab Group
async function getOrCreateGeminiTab(targetUrl = "https://gemini.google.com/app") {
  // Query existing Gemini tabs and pick the healthiest one.
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  let tab = pickGeminiTab(tabs);

  if (!tab) {
    // Create new pinned background tab
    tab = await chrome.tabs.create({ url: targetUrl, active: false, pinned: true });
    tab = await waitTabLoaded(tab.id);
  } else {
    // `--new-chat` asks for a fresh conversation, so navigate the existing tab
    // to the app root instead of leaving it on the previous thread. Without
    // this the flag is a silent no-op and prompts land in the old conversation.
    if (targetUrl && tab.url !== targetUrl) {
      await chrome.tabs.update(tab.id, { url: targetUrl });
      tab = await waitTabLoaded(tab.id);
    } else if (tab.discarded) {
      // A discarded tab has no live content script, so revive it before use.
      await chrome.tabs.reload(tab.id);
      tab = await waitTabLoaded(tab.id);
    } else if (!tabIsReady(tab)) {
      // Still loading, or committed somewhere we did not expect: wait it out.
      tab = await waitTabLoaded(tab.id);
    }
  }

  // Ensure tab is in Tab Group
  await ensureTabGroup(tab.id);

  return tab;
}

/**
 * Wait until a tab is genuinely usable, on a real time budget.
 *
 * The old version ran `40 x 200ms` — an 8s budget, which Gemini's SPA regularly
 * exceeds on a cold load or right after a watchdog reload. It also threw a
 * message blaming "domain permissions", which is a different failure entirely
 * and sent readers hunting for a permissions bug that was not there.
 *
 * Event-driven waiting has one classic trap: if `status:"complete"` already
 * fired before we subscribe, an event-only wait hangs forever. The fix is
 * ordering — subscribe FIRST, then re-check — so a completion landing in
 * between is still observed, by whichever of the two arrives. A slow poll rides
 * alongside as a safety net for tabs (discarded ones especially) whose events we
 * might not hear, and a hard deadline guarantees this always settles, so no
 * caller can be left hanging.
 */
function waitTabLoaded(tabId, options) {
  const budgetMs = (options && options.budgetMs) || TAB_LOAD_BUDGET_MS;
  const deadline = Date.now() + budgetMs;

  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer = null;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const settle = (err, tab) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err); else resolve(tab);
    };

    const check = async () => {
      if (settled) return;
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (err) {
        settle(new Error(`Gemini tab ${tabId} became unavailable while waiting for it to load: ${err.message}`));
        return;
      }
      if (settled) return;
      if (tabIsReady(tab)) {
        settle(null, tab);
        return;
      }
      if (Date.now() >= deadline) {
        settle(new Error(
          `Timed out after ${budgetMs}ms waiting for Gemini tab ${tabId} to finish loading ` +
          `(last seen: ${describeTabState(tab)}).`
        ));
        return;
      }
      pollTimer = setTimeout(check, TAB_LOAD_POLL_MS);
    };

    const onUpdated = (id, changeInfo) => {
      if (id !== tabId || !changeInfo || changeInfo.status !== "complete") return;
      check();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    // Subscribe, THEN look: closes the missed-event race in both directions.
    check();
  });
}

// Group tab into "🤖 Timepass Gemini" group
async function ensureTabGroup(tabId) {
  try {
    const existingGroups = await chrome.tabGroups.query({ title: TAB_GROUP_TITLE });
    let groupId;

    if (existingGroups.length > 0) {
      groupId = existingGroups[0].id;
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, {
        title: TAB_GROUP_TITLE,
        color: TAB_GROUP_COLOR,
        collapsed: false
      });
    }
  } catch (err) {
    console.log("[Timepass MV3] Tab group error:", err);
  }
}

// Actions whose content-script handler returns `true` and resolves asynchronously
// via sendResponse (e.g. inject_and_send awaits simulateTyping). For these we must
// send the message ONCE and await the async response — retrying on `undefined` would
// re-dispatch the action and spawn duplicate DOM operations (e.g. double typing).
const ASYNC_ACTIONS = new Set([
  "type_prompt",
  "inject_and_send",
  "click_send",
  "stream_response",
  // Polls the page until the saved answer settles, so it must be dispatched
  // once and awaited rather than retried on `undefined`.
  "recover_last_response"
]);

// --- Bridge handshake --------------------------------------------------------
// What this build of the worker can actually do. A service worker keeps its
// script in memory, so editing background.js changes nothing until the operator
// reloads the extension. That made the last retest unfalsifiable: fixes landed
// on disk while the live worker ran older code, and bugs were reproduced against
// a build nobody was reviewing. Announcing the real manifest version and the
// real dispatch table lets the host notice the skew instead of guessing.
//
// The list is grouped by HOW each action is served, because the grouping is what
// makes it checkable: DISPATCH_ACTIONS mirrors the if-chain in
// handleServerMessage one-for-one, and a test asserts that correspondence, so a
// new branch cannot be added without advertising it here.
const DISPATCH_ACTIONS = [
  "capture_screenshot",
  "dom_dump",
  "click_button",
  "file_upload",
  "get_page_info",
  "cookies:get",
  "cookies:restore",
  "tab_list",
  "tab_create",
  "tab_close",
  "tab_switch",
  "tab_group_list",
  "inject_and_send"
];

// Served by the generic fall-through at the end of handleServerMessage, which
// forwards anything unclaimed straight to content.js.
const CONTENT_FORWARDED_ACTIONS = [
  "read_history",
  "select_history"
];

// Never host-dispatched through the chain: the freeze watchdog sends this
// itself, and the driver may send it to collect a turn whose reply was lost.
const INTERNAL_ACTIONS = [
  "recover_last_response"
];

const KNOWN_ACTIONS = [
  ...DISPATCH_ACTIONS,
  ...CONTENT_FORWARDED_ACTIONS,
  ...INTERNAL_ACTIONS
];

const BRIDGE_PROTOCOL_VERSION = 1;

/** The build id the *running* worker reports, straight from the manifest. */
function runningBuildId() {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return null;
  }
}

// Helper to send message to tab with retry while content.js initializes
async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  const isAsync = ASYNC_ACTIONS.has(message && message.action);

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res !== undefined) {
        return res;
      }
      // Listener returned undefined. For async actions the response is delivered via
      // sendResponse on the still-open channel, so `chrome.tabs.sendMessage` already
      // resolved with the real value — reaching here means no handler responded.
      // Wait briefly (in case the listener is still initializing on first attempts)
      // but never re-dispatch an async action.
      if (i < maxRetries - 1 && !isAsync) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      // Final attempt (or async action): return a structured failure instead of throwing,
      // so the server relay reports a clean error rather than an undefined-retry crash.
      return {
        success: false,
        error: "Content script returned no response for action: " + (message && message.action)
      };
    } catch (err) {
      // Only re-inject on actual connection errors (no listener registered)
      const isConnectionError = err.message.includes("Could not establish connection") ||
                                err.message.includes("Receiving end does not exist") ||
                                err.message.includes("message channel closed");

      if (isConnectionError && i === 0) {
        console.warn("[Timepass MV3] Content script unreachable. Re-injecting...");

        // Reset the guard so re-injection registers the listener
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => { window.__timepass_listener_registered = false; }
        }).catch(() => { /* Ignore if context is completely gone */ });

        // Re-inject the script. The promise resolves ONLY after
        // the script (and its top-level onMessage listener) has executed.
        // answer-root.js must come first: content.js reads its helper off the
        // global, and injecting content.js alone would silently lose it.
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["answer-root.js", "content.js"]
        }).catch(() => { /* Ignore if re-injection fails */ });

        continue;
      }

      throw err;
    }
  }
  throw new Error("Max retries exceeded for tabId: " + tabId);
}

// --- Screenshot capture ------------------------------------------------------
// `capture_screenshot` used to maximise and focus the window, activate the
// pinned Gemini tab, and then call chrome.tabs.captureVisibleTab. Two problems,
// both observed live:
//
//   * captureVisibleTab only captures the ACTIVE tab of a window the browser is
//     painting. Our tab is deliberately a *pinned background* tab, so the call
//     depends on a foregrounding dance that can fail to take effect -- and when
//     it did, the promise never settled and the driver burned its full 75s
//     budget waiting for a reply that was never coming.
//   * Even on success it stole the operator's window, their active tab and
//     their maximised layout, and never gave any of it back.
//
// The fix is a capture that does not need focus at all, a bounded budget so the
// action can never hang silently, and a restore in a finally so the operator's
// desktop survives even a failure.
const SCREENSHOT_BUDGET_MS = 15000;

/**
 * Run `task` with a hard deadline. The timer is always cleared so a late
 * rejection cannot escape as an unhandled promise.
 */
async function withBudget(task, budgetMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not complete within ${budgetMs}ms`)),
          budgetMs
        );
      })
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Preferred capture path: CDP over chrome.debugger. Page.captureScreenshot
 * works against a background tab, so nothing needs focusing and the operator's
 * desktop is never disturbed. The extension already holds the "debugger"
 * permission and attaches elsewhere in this file, so this adds no permission.
 */
async function captureViaDebugger(tab) {
  const debuggee = { tabId: tab.id };
  try {
    await chrome.debugger.attach(debuggee, "1.3");
  } catch (err) {
    // Typically "Another debugger is already attached" (DevTools open, or the
    // file_upload path is mid-attach). Not fatal: the foreground path below can
    // still serve the request.
    throw new Error(`debugger unavailable (${err.message})`, { cause: err });
  }
  try {
    // Best effort: some Chrome builds want the domain enabled first.
    await chrome.debugger.sendCommand(debuggee, "Page.enable", {}).catch(() => {});
    const result = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true
    });
    if (!result || !result.data) throw new Error("Page.captureScreenshot returned no image data");
    return `data:image/png;base64,${result.data}`;
  } finally {
    // Detach even on failure, or the tab stays debugger-owned and blocks
    // DevTools for the user.
    await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

/**
 * Fallback capture via captureVisibleTab. This one genuinely needs the tab to be
 * the visible active one, so it records what it is about to change and restores
 * all of it in a finally -- including on the failure path, which is exactly
 * when a half-finished foreground would otherwise strand the operator on the
 * wrong tab with a resized window.
 */
async function captureViaForeground(tab) {
  let previousTabId = null;
  let previousWindow = null;

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (activeTab && activeTab.id !== tab.id) previousTabId = activeTab.id;
    const win = await chrome.windows.get(tab.windowId);
    if (win) previousWindow = { state: win.state, focused: win.focused };
  } catch {
    // Best effort: restoring something we failed to record is impossible, but
    // it must never abort the capture itself.
  }

  try {
    await chrome.windows.update(tab.windowId, { state: "maximized", focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 200));
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    if (!dataUrl) throw new Error("captureVisibleTab returned no image");
    return dataUrl;
  } finally {
    if (previousTabId !== null) {
      await chrome.tabs.update(previousTabId, { active: true }).catch(() => {});
    }
    if (previousWindow) {
      await chrome.windows.update(tab.windowId, {
        state: previousWindow.state,
        focused: previousWindow.focused
      }).catch(() => {});
    }
  }
}

/**
 * Capture the Gemini tab, preferring the path that needs no focus and falling
 * back to the legacy one. Every path is bounded, so this always settles in
 * seconds instead of hanging until the driver gives up.
 */
async function captureGeminiScreenshot(tab) {
  let debuggerError;
  try {
    return await withBudget(() => captureViaDebugger(tab), SCREENSHOT_BUDGET_MS, "Page.captureScreenshot");
  } catch (err) {
    debuggerError = err;
  }

  try {
    return await withBudget(() => captureViaForeground(tab), SCREENSHOT_BUDGET_MS, "captureVisibleTab");
  } catch (foregroundError) {
    // Report BOTH failures: "capture did not work" is useless to whoever has to
    // diagnose it, and the two paths fail for entirely different reasons.
    throw new Error(
      `screenshot failed on both paths (debugger: ${debuggerError && debuggerError.message}; ` +
      `foreground: ${foregroundError && foregroundError.message})`,
      { cause: foregroundError }
    );
  }
}

// Handle action dispatch from server to content script
async function handleServerMessage(message) {
  // The host's introduction. Handled before the action chain and kept out of
  // it, so a hello is never mistaken for an action and never reaches the
  // content script. Purely additive: an old driver simply never sends one.
  if (message && message.type === "bridge_hello") {
    handleBridgeHello(message);
    return;
  }

  const { id, action, payload } = message;
  let tab = null;
  // Which step we had reached when something threw. `tab` alone cannot say:
  // it is null both before any tab exists AND after the one we did find was
  // discarded or closed, which is why the old message claimed "No Tab found"
  // for failures that had nothing to do with finding a tab.
  let phase = "dispatch";

  try {
    phase = "resolving the Gemini tab";
    if (action === "capture_screenshot") {
      phase = "resolving the Gemini tab";
      tab = await withBudget(
        () => getOrCreateGeminiTab(payload?.url),
        TAB_LOAD_BUDGET_MS,
        "resolving the Gemini tab for capture"
      );
      phase = "capturing a screenshot";
      const dataUrl = await captureGeminiScreenshot(tab);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { dataUrl } }));
      }
      return;
    }

    if (action === "dom_dump") {
      tab = await getOrCreateGeminiTab(payload?.url);
      const response = await sendMessageWithRetry(tab.id, { id, action: "dom_dump", payload });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response }));
      }
      return;
    }

    if (action === "click_button") {
      tab = await getOrCreateGeminiTab(payload?.url);
      const { selector } = payload || {};
      if (!selector || typeof selector !== "string" || !selector.trim()) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, success: false, error: "Invalid payload.selector" }));
        }
        return;
      }
      const response = await sendMessageWithRetry(tab.id, { id, action, payload });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response }));
      }
      return;
    }

    if (action === "file_upload") {
      tab = await getOrCreateGeminiTab(payload?.url);
      const debuggee = { tabId: tab.id };
      let debuggerAttached = false;

      // What each step actually saw on the page. A failure used to be a single
      // sentence that named none of the attempts, so the next round of debugging
      // started from zero; every step below records its evidence here instead.
      const trace = [];
      const note = (step, detail) => { trace.push(step + ": " + detail); };

      // One in-page helper, reused by every step. It returns the ELEMENT rather
      // than a description of it, and a handle to an element crosses the shadow
      // boundary for free. That is the whole point: re-finding the element from
      // the document with DOM.querySelector cannot cross it, because that command
      // takes only nodeId + selector and has no `pierce` option (only
      // DOM.getDocument / DOM.getFlattenedDocument expose one).
      //
      // NOTE: this is a template literal, so backslashes in the embedded source
      // must be doubled or they are eaten by the enclosing string.
      const PAGE_HELPER_JS = `(function (mode) {
  function visible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  function labelOf(el) {
    var a = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    return ((a || el.textContent) || '').replace(/\\s+/g, ' ').trim();
  }
  // The one traversal, shared by every mode: light DOM first, then each open
  // shadow root. Depth-limited so a pathological page cannot hang the tab.
  function walk(root, depth, visit) {
    if (depth > 16 || !root || typeof root.querySelectorAll !== 'function') return false;
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (visit(all[i]) === true) return true;
      if (all[i].shadowRoot && walk(all[i].shadowRoot, depth + 1, visit) === true) return true;
    }
    return false;
  }

  if (mode === 'find-input') {
    var input = null;
    walk(document, 0, function (el) {
      if (!el.matches || !el.matches('input[type="file"]')) return false;
      input = el;
      return true;
    });
    return input;
  }

  if (mode === 'open-menu') {
    var pool = [];
    walk(document, 0, function (el) {
      if (el.matches && el.matches('button, [role="button"], mat-icon-button, gem-icon-button')) pool.push(el);
      return false;
    });
    var seen = pool.map(labelOf).filter(Boolean).slice(0, 40);
    // Exact match first: it is the only one ever observed to work. The scan is
    // the drift fallback, so a rename, a restructure or a localised label does
    // not have to be a code change before the upload path works again.
    var exact = document.querySelector("button[aria-label='Upload and tools']");
    var target = visible(exact) ? exact : null;
    var how = target ? 'exact aria-label match' : null;
    for (var i = 0; !target && i < pool.length; i++) {
      if (visible(pool[i]) && /upload|attach/i.test(labelOf(pool[i]))) {
        target = pool[i];
        how = 'visible control named ' + JSON.stringify(labelOf(pool[i]));
      }
    }
    if (target) target.click();
    if (!target) how = 'no visible upload or attach control found';
    return { clicked: !!target, how: how, candidates: seen };
  }

  if (mode === 'click-upload-item') {
    var pool = [];
    walk(document, 0, function (el) {
      if (el.matches && el.matches('[role="menuitem"], [role="menuitemcheckbox"], mat-menu-item, mat-list-item, button, a, div, span')) pool.push(el);
      return false;
    });
    var seen = pool.map(labelOf).filter(Boolean).slice(0, 60);
    var target = null;
    var how = null;
    var cands = [];
    for (var i = 0; i < pool.length; i++) {
      var el = pool[i];
      if (!visible(el)) continue;
      // Prefix matching, not equality: a real row carries a badge, a count or a
      // nested label, so "Upload files" never compares equal to the whole row.
      if (/^upload|^attach|^add file|^add image|^insert/i.test(labelOf(el))) cands.push(el);
    }
    // Click the innermost match. A wrapper row's textContent starts with the
    // same prefix as the control nested inside it, so comparing labels cannot
    // separate them; filtering to the candidates that contain no other
    // candidate is what lands the click on the element with the real handler.
    var leaves = cands.filter(function (el) {
      return !cands.some(function (other) {
        return other !== el && typeof el.contains === 'function' && el.contains(other);
      });
    });
    target = leaves.length ? leaves[0] : null;
    if (target) how = 'menu item ' + JSON.stringify(labelOf(target));
    if (target) target.click();
    return { clicked: !!target, how: how, candidates: seen };
  }

  return { clicked: false, how: 'unknown mode ' + mode, candidates: [] };
})`;

      const evaluateHelper = async (mode, returnByValue) => {
        const { result, exceptionDetails } = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: "(" + PAGE_HELPER_JS + ")('" + mode + "')",
          returnByValue: !!returnByValue,
          objectGroup: "timepass-file-upload"
        });
        if (exceptionDetails) {
          const ex = exceptionDetails.exception;
          throw new Error("page helper '" + mode + "' threw: " + ((ex && (ex.description || ex.value)) || exceptionDetails.text));
        }
        return result;
      };

      // A handle to the input, or null. Resolving it to a nodeId is optional:
      // DOM.setFileInputFiles also takes an objectId directly, so both paths are
      // attempted rather than betting the upload on one of them.
      const findFileInput = async () => {
        const res = await evaluateHelper("find-input", false);
        return res && res.objectId ? res.objectId : null;
      };

      // Declared here, beside the helper that closes over it. It used to be
      // declared inside the try below, which left setFilesOn referencing a
      // binding that did not enclose it, so every upload that reached the
      // resolution path threw a ReferenceError instead of setting the files.
      // Hoisting it here keeps the behaviour: the validation still runs before
      // the debugger is attached, because the attach is further down inside try.
      const filePaths = Array.isArray(payload.filePaths)
        ? payload.filePaths
        : (payload.filePath ? [payload.filePath] : []);

      const setFilesOn = async (objectId) => {
        let nodeId = 0;
        try {
          ({ nodeId } = await chrome.debugger.sendCommand(debuggee, "DOM.requestNode", { objectId }));
        } catch { /* requestNode is best-effort; the objectId path below still works */ }
        if (nodeId) {
          await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", { files: filePaths, nodeId });
        } else {
          await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", { files: filePaths, objectId });
        }
      };

      const finish = async (via) => {
        try {
          await chrome.debugger.sendCommand(debuggee, "Runtime.releaseObjectGroup", { objectGroup: "timepass-file-upload" });
        } catch { /* the group is dropped with the execution context anyway */ }
        await chrome.debugger.detach(debuggee);
        debuggerAttached = false;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            id,
            success: true,
            response: { success: true, result: "file uploaded (" + via + ")", trace }
          }));
        }
      };

      try {
        // Validated here rather than at the declaration so the failure keeps
        // reporting through this handler's own reply, exactly as before, and
        // still fires before the debugger is attached.
        if (filePaths.length === 0) {
          throw new Error('file_upload requires payload.filePath or payload.filePaths');
        }

        try {
          await chrome.debugger.attach(debuggee, "1.3");
          debuggerAttached = true;
        } catch (attachErr) {
          throw new Error('Failed to attach debugger: ' + attachErr.message + '. Make sure Chrome DevTools is closed.', { cause: attachErr });
        }

        // Priming the DOM agent is not needed to reach the input any more, but
        // it keeps node resolution on the same warm path the rest of the
        // extension's debugger use relies on.
        await chrome.debugger.sendCommand(debuggee, "DOM.getDocument");

        // 1. An input already on the page needs no menu at all.
        let objectId = await findFileInput();
        if (objectId) {
          await setFilesOn(objectId);
          note("input", "found a file input already present in the page");
          await finish("direct search");
          return;
        }
        note("input", "no file input in the page (light DOM or any open shadow root)");

        // 2. Open the attachment menu, which is what creates the input.
        const open = (await evaluateHelper("open-menu", true)).value || {};
        note("open-menu", "clicked=" + !!open.clicked + (open.how ? " via " + open.how : "") +
          "; visible candidates=" + JSON.stringify(open.candidates || []));
        if (!open.clicked) {
          throw new Error('Upload trigger not found. ' + trace.join(" | "));
        }
        await new Promise(r => setTimeout(r, 1500));

        objectId = await findFileInput();
        if (objectId) {
          await setFilesOn(objectId);
          note("input", "file input appeared once the menu was opened");
          await finish("after opening the menu");
          return;
        }
        note("input", "still no file input after opening the menu");

        // 3. Open the menu's own upload entry, which is what creates the input.
        const menu = (await evaluateHelper("click-upload-item", true)).value || {};
        note("menu-item", "clicked=" + !!menu.clicked + (menu.how ? " via " + menu.how : "") +
          "; menu candidates=" + JSON.stringify(menu.candidates || []));
        await new Promise(r => setTimeout(r, 1500));

        objectId = await findFileInput();
        if (!objectId) {
          throw new Error('File input not found after opening the upload menu and its items. ' +
            trace.join(" | "));
        }
        await setFilesOn(objectId);
        note("input", "file input appeared after clicking the menu item");
        await finish("after clicking the menu item");
      } catch (err) {
        // Detach on error
        if (debuggerAttached) {
          try { await chrome.debugger.detach({ tabId: tab.id }); } catch { /* ignore */ }
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, success: true, response: { success: false, error: err.message, trace } }));
        }
      }
      return;
    }

    if (action === "get_page_info") {
      tab = await getOrCreateGeminiTab(payload?.url);
      const response = await sendMessageWithRetry(tab.id, { id, action, payload });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response }));
      }
      return;
    }

    if (action === "cookies:get") {
      const data = await readCookiesForDomain(payload?.domain || "gemini.google.com");
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { cookies: data } }));
      }
      return;
    }

    if (action === "tab_list") {
      const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
      const groups = await chrome.tabGroups.query({});
      const result = tabs.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        pinned: t.pinned,
        status: t.status,
        groupId: t.groupId,
        groupName: groups.find(g => g.id === t.groupId)?.title || null,
      }));
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { tabs: result } }));
      }
      return;
    }

    if (action === "tab_create") {
      const url = payload?.url || "https://gemini.google.com/app";
      const pinned = payload?.pinned !== false;
      const active = payload?.active === true;
      const tab = await chrome.tabs.create({ url, pinned, active });
      await ensureTabGroup(tab.id);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { tabId: tab.id, url: tab.url } }));
      }
      return;
    }

    if (action === "tab_close") {
      const tabId = payload?.tabId;
      if (!tabId) throw new Error("tab_close requires payload.tabId");
      await chrome.tabs.remove(tabId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { closed: tabId } }));
      }
      return;
    }

    if (action === "tab_switch") {
      const tabId = payload?.tabId;
      if (!tabId) throw new Error("tab_switch requires payload.tabId");
      const tab = await chrome.tabs.get(tabId);
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { switched: tabId } }));
      }
      return;
    }

    if (action === "tab_group_list") {
      const groups = await chrome.tabGroups.query({});
      const result = groups.map(g => ({
        id: g.id,
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
      }));
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { groups: result } }));
      }
      return;
    }

    if (action === "cookies:restore") {
      await writeCookies(payload?.domain || "gemini.google.com", payload?.cookies || []);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, success: true, response: { ok: true } }));
      }
      return;
    }

    tab = await getOrCreateGeminiTab(payload?.url);

    // Arm the freeze watchdog for the live ask path. Only a *confirmed* freeze
    // (consecutive silent windows, not a single gap) triggers a reload, so a
    // slow but healthy long generation is never interrupted. The turn carries
    // the caller's own budget so the silence window can be sized against it
    // rather than against one global constant.
    if (action === "inject_and_send") {
      activeTurn = {
        id,
        tabId: tab.id,
        startedAt: Date.now(),
        lastBeatAt: Date.now(),
        budgetMs: turnBudgetMs(payload, message),
        handled: false
      };
    }

    // Send action to content script in the Gemini tab with retry
    phase = "sending the action to the content script";
    const response = await sendMessageWithRetry(tab.id, { id, action, payload });

    // Send result back to server
    phase = "replying to the host";
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id, success: true, response }));
    }
  } catch (err) {
    // Say what actually happened. "No Tab found" was a lie whenever
    // getOrCreateGeminiTab threw: `tab` was null because resolution failed, not
    // because no tabs existed, and the message sent readers looking for a
    // missing tab instead of a load timeout.
    const tabDetails = tab
      ? describeTabState(tab)
      : `no tab resolved (failed while ${phase})`;
    console.error(`[Timepass MV3] Action dispatch error. ${tabDetails}. Details:`, err);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id, success: false, error: `${err.message} (${tabDetails})` }));
    }
  }
}

// Keep-alive heartbeat & auto-reconnect (with exponential backoff)
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
    reconnectAttempts = 0;
  } else if (!reconnectTimer) {
    // Backoff is computed per *attempt*, not per *tick*: otherwise every 2s
    // poll while offline queues another overlapping timer and the extension
    // opens a pile of orphaned sockets, each of which nulls the shared
    // clientSocket on close and breaks the live one. Schedule at most one.
    const backoffMs = Math.min(2000 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWebSocket();
    }, backoffMs);
  }
}, 2000);

// --- Freeze recovery --------------------------------------------------------
// A tab whose main thread is blocked cannot heal itself: the content script
// that would notice is frozen along with the page. So the watchdog lives here,
// in a separate JS context that stays responsive, and decides from silence.
// Silence is the signal: a slow-but-alive page keeps beating, a frozen one
// cannot.
//
// The gap this region is defending against is subtle. Silence is not proof of
// death: a missed beat, a GC pause, a stalled event loop or a slow worker
// dispatch all look identical to a freeze from out here. The original design
// reloaded on a single 20s gap, so ANY such hiccup destroyed a live answer and
// forced it through the fragile recovery path (#3). Two rules fix that without
// weakening freeze detection much:
//
//   1. The silence window is derived from *this turn's* budget, not a global
//      constant. A caller that allowed 20s must get its recovery inside 20s;
//      a caller that allowed 10 minutes should not have a frozen tab left
//      sitting there.
//   2. A reload needs `requiredWindows` CONSECUTIVE silent windows. A single
//      gap is treated as a suspicion, not a verdict: if the page was only
//      briefly unobservable it resumes beating, the counter resets, and the
//      answer is never touched.
//
// TRADE-OFF, stated plainly: because a verdict now needs two full windows,
// worst-case detection is ~2x the window instead of 1x. At the default 60s
// budget that is ~30s of silence (plus up to one 2s poll tick) versus the old
// 20-22s. A genuinely frozen tab is still caught well inside any sane caller's
// budget, and the alternative -- reloading on one gap -- is what caused the
// data loss in the first place. The window floor/cap below keep the worst case
// bounded to ~40s even for very long turns.
const FREEZE_POLICY = {
  // Silence window = budget / budgetDivisor, clamped to this range.
  minWindowMs: 8000,
  maxWindowMs: 20000,
  budgetDivisor: 4,
  // Used when the caller declared no budget at all.
  defaultBudgetMs: 60000,
  // Consecutive silent windows required before a reload is considered.
  requiredWindows: 2,
  // A heartbeat `ts` further than this from our own clock is not trusted.
  maxBeatSkewMs: 300000
};

/** The turn currently being observed, or null when idle. */
let activeTurn = null;

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * The caller's budget for this turn, in ms. The adapter puts `timeoutMs` on the
 * content-script payload and the driver puts it on the envelope, so accept
 * either; fall back to the policy default when neither is a usable number.
 */
function turnBudgetMs(payload, envelope) {
  const candidates = [payload && payload.timeoutMs, envelope && envelope.timeoutMs];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return FREEZE_POLICY.defaultBudgetMs;
}

/**
 * The silence window for one turn. Sizing it from the budget keeps the
 * watchdog's verdict inside the caller's patience: 2 * window stays below the
 * budget for every budget at or above ~16s, so recovery still beats the driver
 * giving up.
 */
function freezeWindowMs(turn, policy) {
  const p = policy || FREEZE_POLICY;
  const budget = Number(turn && turn.budgetMs);
  const base = Number.isFinite(budget) && budget > 0 ? budget : p.defaultBudgetMs;
  return clamp(Math.floor(base / p.budgetDivisor), p.minWindowMs, p.maxWindowMs);
}

/**
 * Record a heartbeat against a turn. Pure apart from its arguments.
 *
 * The page stamps its own `ts`, and that is the only moment we know for
 * certain the page was alive. Crediting the *received* time instead (the old
 * behaviour) invents liveness the page never proved: when the worker is busy
 * and a beat emitted at T arrives at T+30s, receive-time says "alive at T+30s"
 * while the page may have frozen at T+1s, so a real freeze is detected late.
 * Using the emitted time is both more truthful and safer here. It is clamped to
 * never exceed our own clock, so a bogus future `ts` cannot mute the watchdog
 * for the life of the turn, and ignored entirely if implausible.
 */
function noteHeartbeat(turn, message, receivedAt, policy) {
  if (!turn) return turn;
  const p = policy || FREEZE_POLICY;
  const ts = Number(message && message.ts);
  const plausible = Number.isFinite(ts) && ts > 0 && Math.abs(receivedAt - ts) <= p.maxBeatSkewMs;
  const emittedAt = plausible ? Math.min(ts, receivedAt) : receivedAt;
  return {
    ...turn,
    // Guard against out-of-order delivery walking lastBeatAt backwards.
    lastBeatAt: Math.max(turn.lastBeatAt, emittedAt),
    lastBeatLagMs: Math.max(0, receivedAt - emittedAt)
  };
}

/**
 * What the watchdog should do about a turn that has gone quiet. Pure: `now`
 * is passed in so the policy is directly testable without a fake clock.
 */
function decideFreezeAction(turn, now, policy) {
  const p = policy || FREEZE_POLICY;
  if (!turn || turn.handled) return { action: "none", reason: "no-turn" };

  const windowMs = freezeWindowMs(turn, p);
  const silenceMs = Math.max(0, now - turn.lastBeatAt);
  const missedWindows = Math.floor(silenceMs / windowMs);
  if (missedWindows < p.requiredWindows) {
    return { action: "none", reason: "awaiting-corroboration", silenceMs, windowMs, missedWindows };
  }
  return { action: "reload", reason: "confirmed-freeze", silenceMs, windowMs, missedWindows };
}

// Relays messages from content script back to server
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  // Liveness beacon: kept in the worker, never forwarded. A page that is slow
  // but alive keeps sending these; a tab with a blocked main thread goes
  // silent, and that silence is what the watchdog acts on.
  if (message.type === "turn_heartbeat") {
    activeTurn = noteHeartbeat(activeTurn, message, Date.now(), FREEZE_POLICY);
    return;
  }
  if (message.type === "turn_complete") {
    activeTurn = null;
  }
  if (message.type === "stream_delta" || message.type === "turn_complete" || message.type === "extension_log") {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (err) {
        console.error("[Timepass MV3] Failed to relay message to server:", err);
      }
    }
  }
});

async function handleFreezeWatchdog() {
  const decision = decideFreezeAction(activeTurn, Date.now(), FREEZE_POLICY);
  if (decision.action !== "reload") return;

  const turn = activeTurn;
  turn.handled = true;
  console.warn(`[Timepass MV3] Gemini tab silent for ${decision.silenceMs}ms across ${decision.missedWindows} windows (window ${decision.windowMs}ms) with a turn in flight; reloading to recover the saved response.`);

  try {
    await chrome.tabs.reload(turn.tabId);
    await waitTabLoaded(turn.tabId);
    // The conversation is re-rendered from the server, so the answer that was
    // already produced is recovered rather than re-asked.
    const res = await sendMessageWithRetry(turn.tabId, {
      action: "recover_last_response",
      payload: { timeoutMs: 45000 }
    });
    if (!res || res.success !== true) {
      throw new Error((res && res.error) || "recovery returned no response");
    }
    activeTurn = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        id: turn.id,
        success: true,
        response: { success: true, turnComplete: true, recovered: true, text: res.text, chatId: res.chatId }
      }));
    }
  } catch (err) {
    console.error("[Timepass MV3] Freeze recovery failed:", err);
    activeTurn = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        id: turn.id,
        success: false,
        error: `Tab froze and the saved response could not be recovered: ${err.message}`
      }));
    }
  }
}

setInterval(() => { handleFreezeWatchdog().catch(() => {}); }, 2000);

// Connect on worker start
connectWebSocket();


// Cookie Helper: Read cookies for domain
async function readCookiesForDomain(domain) {
  const cookies = await chrome.cookies.getAll({ domain });
  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    expirationDate: c.expirationDate,
    session: c.session,
    host: `https://${c.domain.replace(/^\./, "")}${c.path}`
  }));
}

// Cookie Helper: Restore cookies
async function writeCookies(domain, payload) {
  const existing = await chrome.cookies.getAll({ domain });
  await Promise.all(
    existing.map(c => chrome.cookies.remove({
      url: `https://${c.domain.replace(/^\./, "")}${c.path}`,
      name: c.name
    }))
  );

  for (const c of payload) {
    await chrome.cookies.set({
      url: c.host,
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate
    });
  }
}

// --- Test seam ---------------------------------------------------------------
// The pure decision helpers are published onto globalThis so the vitest suite can
// drive them directly. An MV3 service worker is evaluated once into its own
// scope and cannot use ESM `export`, so this inert global is the harness. It is
// namespaced (`__timepassInternals`) and the assignment is a harmless no-op in
// production.
if (typeof globalThis !== "undefined") {
  globalThis.__timepassInternals = {
    decideFreezeAction,
    freezeWindowMs,
    noteHeartbeat,
    turnBudgetMs,
    clamp,
    FREEZE_POLICY,
    tabIsReady,
    compareGeminiTabs,
    pickGeminiTab,
    describeTabState,
    TAB_LOAD_BUDGET_MS,
    withBudget,
    runningBuildId,
    DISPATCH_ACTIONS,
    CONTENT_FORWARDED_ACTIONS,
    INTERNAL_ACTIONS,
    KNOWN_ACTIONS,
    BRIDGE_PROTOCOL_VERSION,
    ASYNC_ACTIONS
  };
}