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

// Universal observeResponse — waits for completion signal (copy button)
// then returns response text. Uses crawl4ai waitForElement pattern.
async function observeResponse(config = {}) {
  const {
    responseSelector = 'response-container:last-child',
    completionSelector = 'response-container:last-child button[aria-label="Copy"]',
    errorSelectors = ["[role='alert']", "[class*='error']", "[class*=' Error ']"],
    settleMs = 3000,
    timeoutMs = 60000
  } = config;

  // Wait for response container to appear
  const responseEl = await waitForElement(responseSelector, timeoutMs);

  // Wait for completion signal (copy button)
  await waitForElement(completionSelector, timeoutMs);

  // Check for errors in response
  for (const errSel of errorSelectors) {
    const errEl = responseEl.querySelector(errSel);
    if (errEl && errEl.innerText && errEl.innerText.trim()) {
      throw new Error(`Gemini error: ${errEl.innerText.trim()}`);
    }
  }

  // Settling delay to ensure all content is rendered
  await new Promise(r => setTimeout(r, settleMs));

  return responseEl.innerText.trim();
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
    'button[aria-label*="Send"]',
    'button[aria-label*="send"]',
    'button.send-button',
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
