# Chrome MV3 Content Script: "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"

## Problem

Chrome MV3 extension. Background service worker sends a message to a content script. The content script's `onMessage` listener returns `true` for async responses (like `type_prompt` which calls `simulateTyping`). But immediately after sending, Chrome throws:

> "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"

This happens on the FIRST attempt — no re-injection, no tab refresh, no navigation. The content script is loaded (confirmed by logs). The listener returns `true`, but the channel closes before `sendResponse` is called.

## Current content.js structure

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (action === "type_prompt") {
    simulateTyping(editor, payload.text).then(() => {
      sendResponse({ success: true });
    });
    return true; // async
  }
  // ... other handlers ...
  return true; // <-- keeps channel open for unhandled messages
});
```

## Current sendMessageWithRetry (background.js)

```javascript
async function sendMessageWithRetry(tabId, message, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, message);
      if (res !== undefined) return res;
      if (i < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw new Error("Receiving end returned undefined.");
    } catch (err) {
      const isConnectionError = err.message.includes("Could not establish connection") || 
                                err.message.includes("Receiving end does not exist");
      if (isConnectionError && i === 0) {
        // Reset guard and re-inject
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        continue;
      }
      throw err;
    }
  }
}
```

## Questions

1. Why does the message channel close immediately after the listener returns `true`? The content script is still running `simulateTyping` (30ms per chunk), so it shouldn't be unloaded.

2. Could the background service worker be going to sleep during the async wait? The SW has a keep-alive heartbeat every 2 seconds via `setInterval`. Does `chrome.tabs.sendMessage` keep the SW alive during the response wait?

3. Is the `return true` at the END of the listener (outside any `if` block) causing this? Does returning `true` for ALL messages (even unhandled ones) confuse Chrome's message channel management?

4. Should we use `chrome.runtime.connect()` (long-lived port) instead of `chrome.tabs.sendMessage()` for async actions like `type_prompt`? Would this avoid the channel closing?

5. Is there a way to keep the message channel open while waiting for an async response? Some sources suggest calling `sendResponse` with a dummy value first, then sending the real response later via `port.postMessage`. Is this valid?

## Context

- Manifest V3, background service worker (not persistent)
- Content script loaded on gemini.google.com via manifest (`run_at: document_idle`)
- `simulateTyping` takes ~500ms to complete (15 chars per 30ms chunk)
- Error occurs immediately, not after a timeout
- No re-injection or tab refresh happening
