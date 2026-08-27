# Chrome Extension MV3 Message Passing — Research Findings

Source: https://developer.chrome.com/docs/extensions/develop/concepts/messaging

## One-Time Requests

- `chrome.runtime.sendMessage()` / `chrome.tabs.sendMessage()` return a Promise
- Listener must call `sendResponse()` synchronously by default
- For async responses, two options:
  1. **Return `true`** from listener — keeps channel open, call `sendResponse()` later
  2. **Return a Promise** (Chrome 148+) — resolved value becomes the response

## Critical Gotcha: Async Listener Pitfall

```js
// BUG: async function always returns a promise, even without return statement
chrome.runtime.onMessage.addListener(async (message) => {
  await someAsyncWork();
  // implicit `return undefined;` — Chrome sends null as response!
});
```

**Fix:** Always explicitly return from async listeners:
```js
chrome.runtime.onMessage.addListener(async (message) => {
  const result = await someAsyncWork();
  return result; // explicit return
});
```

## Error Handling (Chrome 146+)

- If listener throws synchronously or returns rejected promise, `sendMessage()` rejects with error message
- Only the **first listener to respond/reject/throw** affects the sender
- Non-serializable responses (functions, DOM nodes) cause rejection

## Long-Lived Connections

- `chrome.runtime.connect({name: "channel"})` — content script to extension
- `chrome.tabs.connect(tabId, {name: "channel"})` — extension to content script
- Returns `runtime.Port` object with `postMessage()` and `onMessage`
- Better for: streaming data, multiple messages, stateful interactions

## Relevance to timepass

### Current issue
Content script returns `true` for async `inject_and_send`, calls `sendResponse()` after `simulateTyping`. This SHOULD work per Chrome docs. But `chrome.tabs.sendMessage()` promise may resolve with `undefined` before `sendResponse` in some Chrome versions.

### Recommended pattern for streaming
Use `chrome.tabs.connect()` for the response stream (long-lived port), keep `sendMessage` for the one-shot command:

```js
// background.js — send command
const port = chrome.tabs.connect(tabId, {name: "stream"});
port.postMessage({action: "inject_and_send", payload});

// content.js — receive command, stream back
chrome.runtime.onConnect.addListener(port => {
  if (port.name === "stream") {
    port.onMessage.addListener(async (msg) => {
      // ... type, click, observe ...
      port.postMessage({type: "stream_delta", text});
      port.postMessage({type: "turn_complete", text});
    });
  }
});
```

### Alternative: Return Promise (Chrome 148+)
```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "inject_and_send") {
    return new Promise(async (resolve) => {
      await simulateTyping(editor, text);
      clickSend();
      resolve({success: true});
    });
  }
});
```
