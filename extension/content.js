// Timepass Gemini Extension - Content Script (gemini.google.com)

// ===== ONE-TIME SETUP (guarded against re-injection) =====
if (!window.__timepass_content_loaded) {
  window.__timepass_content_loaded = true;

  // Remote console log interceptor
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInfo = console.info;

  function sendRemoteLog(level, args) {
    try {
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
  return new Promise((resolve) => {
    const chunkSize = 15;
    let i = 0;
    const interval = setInterval(() => {
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

// Chrome message handler (registered on every injection)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action, payload } = message || {};

  if (action === "type_prompt") {
    const editor = findInputEditor();
    if (!editor) {
      sendResponse({ success: false, error: "Input editor not found" });
      return;
    }
    simulateTyping(editor, payload.text).then(() => {
      sendResponse({ success: true });
    });
    return true; // keep message channel open for async
  }

  if (action === "click_send") {
    const selectors = [
      'button[aria-label*="Send"]',
      'button[aria-label*="send"]',
      'button.send-button',
      'button[mattooltip*="Send"]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="Generate"]'
    ];

    let button = null;
    for (const sel of selectors) {
      button = document.querySelector(sel);
      if (button) break;
    }

    if (!button) {
      sendResponse({ success: false, error: "Send button not found" });
      return;
    }

    button.click();
    sendResponse({ success: true });
  }

  if (action === "stream_response") {
    const selectors = [
      ".response-content",
      ".markdown",
      "[class*='response']",
      "[class*='model-response']",
      "[class*='message-content']"
    ];

    let responseEl = null;
    for (const sel of selectors) {
      responseEl = document.querySelector(sel);
      if (responseEl) break;
    }

    if (!responseEl) {
      sendResponse({ success: false, error: "Response element not found" });
      return;
    }

    // Set up MutationObserver to stream response
    if (window.__timepass_activeMutationObserver) {
      window.__timepass_activeMutationObserver.disconnect();
    }

    window.__timepass_activeMutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList" || mutation.type === "characterData") {
          const text = responseEl.innerText;
          chrome.runtime.sendMessage({
            type: "response_chunk",
            text: text
          });
        }
      }
    });

    window.__timepass_activeMutationObserver.observe(responseEl, {
      childList: true,
      characterData: true,
      subtree: true
    });

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

  if (action === "file_upload") {
    try {
      const { base64Data, fileName, mimeType } = payload;

      // Step 1: Click the upload button to reveal the file input
      const uploadBtn = document.querySelector("button[aria-label='Upload and tools']");
      if (uploadBtn) {
        uploadBtn.click();
      }

      // Step 2: Poll for file input to appear (max 3 seconds)
      let input = null;
      for (let i = 0; i < 30; i++) {
        const inputs = document.querySelectorAll("input[type='file']");
        if (inputs.length > 0) {
          input = inputs[0];
          break;
        }
        // Busy wait 100ms
        const start = Date.now();
        while (Date.now() - start < 100) { /* spin */ }
      }
      if (!input) {
        sendResponse({ success: false, error: "No file input found" });
        return;
      }

      // Step 3: Decode base64 to binary
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: mimeType });
      const file = new File([blob], fileName, { type: mimeType });

      // Step 4: Create DataTransfer and set files
      const dt = new DataTransfer();
      dt.items.add(file);
      Object.defineProperty(input, 'files', { value: dt.files, configurable: true });

      // Step 5: Dispatch change event
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));

      sendResponse({ success: true, result: "file set on input" });
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
});

// DOM Subtree Serializer
function serializeSubtree(rootSelector, opts = {}) {
  const MAX_DEPTH = opts.maxDepth || 10;

  function walk(el, depth) {
    if (!el || depth > MAX_DEPTH) return null;

    const node = {
      tag: el.tagName?.toLowerCase() || "",
      className: el.className || "",
      attributes: {},
      visible: el.offsetParent !== null || el.tagName === "BODY",
      inViewport: isElementInViewport(el),
      rect: el.getBoundingClientRect ? {
        x: el.getBoundingClientRect().x,
        y: el.getBoundingClientRect().y,
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height
      } : null
    };

    // Add attributes
    if (el.attributes) {
      for (const attr of el.attributes) {
        node.attributes[attr.name] = attr.value;
      }
    }

    // Form values
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
