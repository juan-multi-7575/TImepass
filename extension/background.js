// Timepass Gemini Extension - Background Service Worker

let ws = null;
let reconnectAttempts = 0;
const MAX_BACKOFF_MS = 30000; // 30s max

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
  } catch (err) {
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
    chrome.storage.local.set({ status: "disconnected" });
    ws = null;
  }
}

// Ensure Gemini tab exists and is in the "Timepass Gemini" Tab Group
async function getOrCreateGeminiTab(targetUrl = "https://gemini.google.com/app") {
  // Query existing Gemini tabs
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  let tab = tabs[0];

  if (!tab) {
    // Create new pinned background tab
    tab = await chrome.tabs.create({ url: targetUrl, active: false, pinned: true });
    tab = await waitTabLoaded(tab.id);
  } else {
    // If background tab was discarded by Chrome, reload it to awake content.js
    if (tab.discarded || tab.status === "loading") {
      if (tab.discarded) {
        await chrome.tabs.reload(tab.id);
      }
      tab = await waitTabLoaded(tab.id);
    }
  }

  // Ensure tab is in Tab Group
  await ensureTabGroup(tab.id);

  return tab;
}

// Wait for a tab to finish loading and commit URL
async function waitTabLoaded(tabId) {
  for (let i = 0; i < 40; i++) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && tab.url && tab.url.includes("gemini.google.com")) {
      return tab;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timeout waiting for Gemini tab to load and commit domain permissions.");
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
  "stream_response"
]);

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
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"]
        }).catch(() => { /* Ignore if re-injection fails */ });

        continue;
      }

      throw err;
    }
  }
  throw new Error("Max retries exceeded for tabId: " + tabId);
}

// Handle action dispatch from server to content script
async function handleServerMessage(message) {
  const { id, action, payload } = message;
  let tab = null;

  try {
    if (action === "capture_screenshot") {
      tab = await getOrCreateGeminiTab(payload?.url);
      await chrome.windows.update(tab.windowId, { state: "maximized", focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise((r) => setTimeout(r, 200));
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
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
      
        try {
          const filePaths = Array.isArray(payload.filePaths)
            ? payload.filePaths
            : (payload.filePath ? [payload.filePath] : []);
          if (filePaths.length === 0) {
            throw new Error('file_upload requires payload.filePath or payload.filePaths');
          }
          
          // Step 1: Attach debugger
        try {
          await chrome.debugger.attach(debuggee, "1.3");
          debuggerAttached = true;
        } catch (attachErr) {
          throw new Error('Failed to attach debugger: ' + attachErr.message + '. Make sure Chrome DevTools is closed.', { cause: attachErr });
        }
        
        // Step 2: Get document root
        const { root } = await chrome.debugger.sendCommand(debuggee, "DOM.getDocument");
        
        // Step 3: Try to find file input via DOM.querySelector (light DOM)
        const { nodeId: lightDomNodeId } = await chrome.debugger.sendCommand(debuggee, "DOM.querySelector", {
          nodeId: root.nodeId,
          selector: 'input[type="file"]'
        });
        
        if (lightDomNodeId) {
          // File input found in light DOM, set file directly
          await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
            files: filePaths,
            nodeId: lightDomNodeId
          });
          await chrome.debugger.detach(debuggee);
          
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id, success: true, response: { success: true, result: 'file uploaded (light DOM)' } }));
          }
          return;
        }
        
        // Step 4: File input not in light DOM, search shadow DOM via Runtime.evaluate
        const { result: shadowResult } = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `
            (function() {
              function search(root) {
                const inputs = root.querySelectorAll('input[type="file"]');
                if (inputs.length > 0) return inputs[0];
                const all = root.querySelectorAll('*');
                for (const el of all) {
                  if (el.shadowRoot) {
                    const found = search(el.shadowRoot);
                    if (found) return found;
                  }
                }
                return null;
              }
              const input = search(document);
              if (!input) return null;
              input.setAttribute('data-timepass-target', 'true');
              return 'found';
            })()
          `,
          returnByValue: true
        });
        
        if (shadowResult.value === 'found') {
          // Found in shadow DOM, now find it via the attribute we set
          const { nodeId: shadowNodeId } = await chrome.debugger.sendCommand(debuggee, "DOM.querySelector", {
            nodeId: root.nodeId,
            selector: 'input[type="file"][data-timepass-target="true"]'
          });
          
          if (shadowNodeId) {
            await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
              files: filePaths,
              nodeId: shadowNodeId
            });
            await chrome.debugger.detach(debuggee);
            
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ id, success: true, response: { success: true, result: 'file uploaded (shadow DOM)' } }));
            }
            return;
          }
        }
        
        // Step 5: File input not found in DOM, click upload button to reveal it
        const { result: clickResult } = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `
            (function() {
              const btn = document.querySelector("button[aria-label='Upload and tools']");
              if (!btn) return 'button not found';
              btn.click();
              return 'clicked';
            })()
          `,
          returnByValue: true
        });
        
        if (clickResult.value !== 'clicked') {
          throw new Error('Upload button not found: ' + clickResult.value);
        }
        
        // Step 6: Wait for menu to render
        await new Promise(r => setTimeout(r, 1500));
        
        // Step 7: Search for file input again after menu opens
        const { result: afterClickResult } = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `
            (function() {
              function search(root) {
                const inputs = root.querySelectorAll('input[type="file"]');
                if (inputs.length > 0) return inputs[0];
                const all = root.querySelectorAll('*');
                for (const el of all) {
                  if (el.shadowRoot) {
                    const found = search(el.shadowRoot);
                    if (found) return found;
                  }
                }
                return null;
              }
              const input = search(document);
              if (!input) return null;
              input.setAttribute('data-timepass-target', 'true');
              return 'found';
            })()
          `,
          returnByValue: true
        });
        
        if (afterClickResult.value === 'found') {
          const { nodeId: afterClickNodeId } = await chrome.debugger.sendCommand(debuggee, "DOM.querySelector", {
            nodeId: root.nodeId,
            selector: 'input[type="file"][data-timepass-target="true"]'
          });
          
          if (afterClickNodeId) {
            await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
              files: filePaths,
              nodeId: afterClickNodeId
            });
            await chrome.debugger.detach(debuggee);
            
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ id, success: true, response: { success: true, result: 'file uploaded (after click)' } }));
            }
            return;
          }
        }
        
        // Step 8: Still not found, try clicking "Upload files" menu item
        await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `
            (function() {
              const items = document.querySelectorAll('[role="menuitem"], button, div, span, mat-list-item, a');
              for (const item of items) {
                const text = item.textContent.trim();
                if ((text === 'Upload files' || text === 'Upload from device') && item.offsetParent !== null) {
                  item.click();
                  return 'clicked: ' + text;
                }
              }
              return 'menu item not found';
            })()
          `,
          returnByValue: true
        });
        
        // Step 9: Wait for file input to appear
        await new Promise(r => setTimeout(r, 1500));
        
        // Step 10: Final search for file input
        const { result: finalResult } = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
          expression: `
            (function() {
              function search(root) {
                const inputs = root.querySelectorAll('input[type="file"]');
                if (inputs.length > 0) return inputs[0];
                const all = root.querySelectorAll('*');
                for (const el of all) {
                  if (el.shadowRoot) {
                    const found = search(el.shadowRoot);
                    if (found) return found;
                  }
                }
                return null;
              }
              const input = search(document);
              if (!input) return null;
              input.setAttribute('data-timepass-target', 'true');
              return 'found';
            })()
          `,
          returnByValue: true
        });
        
        if (finalResult.value !== 'found') {
          throw new Error('File input not found after all attempts (light DOM, shadow DOM, button click, menu click)');
        }
        
        const { nodeId: finalNodeId } = await chrome.debugger.sendCommand(debuggee, "DOM.querySelector", {
          nodeId: root.nodeId,
          selector: 'input[type="file"][data-timepass-target="true"]'
        });
        
        if (!finalNodeId) {
          throw new Error('Could not get nodeId for file input');
        }
        
        await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
          files: filePaths,
          nodeId: finalNodeId
        });
        
        // Step 11: Detach debugger
        await chrome.debugger.detach(debuggee);
        debuggerAttached = false;
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, success: true, response: { success: true, result: 'file uploaded (final attempt)' } }));
        }
      } catch (err) {
        // Detach on error
        if (debuggerAttached) {
          try { await chrome.debugger.detach({ tabId: tab.id }); } catch (_e) { /* ignore */ }
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id, success: true, response: { success: false, error: err.message } }));
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

    // Send action to content script in the Gemini tab with retry
    const response = await sendMessageWithRetry(tab.id, { id, action, payload });

    // Send result back to server
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id, success: true, response }));
    }
  } catch (err) {
    const tabDetails = tab ? `Tab URL: ${tab.url}, Status: ${tab.status}` : "No Tab found";
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
  } else {
    const backoffMs = Math.min(2000 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
    reconnectAttempts++;
    setTimeout(() => connectWebSocket(), backoffMs);
  }
}, 2000);

// Relays messages from content script back to server
chrome.runtime.onMessage.addListener((message, sender) => {
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