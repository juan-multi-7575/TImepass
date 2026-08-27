# Chrome Extension Content Scripts — Research Findings

Source: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts

## Key Concepts

### Isolated World
- Content scripts run in an isolated execution environment
- Cannot access page's JavaScript variables or functions
- CAN access the DOM (read/write)
- CAN access limited extension APIs: `runtime`, `storage`, `dom`, `i18n`

### Injection Methods

1. **Static declaration** (manifest.json) — auto-run on matching URLs
2. **Dynamic declaration** (`chrome.scripting.registerContentScripts`) — registered at runtime
3. **Programmatic injection** (`chrome.scripting.executeScript`) — on-demand

### Programmatic Injection Pattern
```js
// service-worker.js
chrome.scripting.executeScript({
  target: { tabId: tab.id },
  files: ["content-script.js"]
});
```

### Re-injection Behavior
- Static scripts: injected once per page load
- Programmatic scripts: can be injected multiple times
- Content scripts are NOT re-injected when extension reloads (page must reload)

## Relevance to timepass

### Current issue
After extension reload, content.js doesn't re-inject into existing tabs. The user must reload the Gemini tab.

### Fix options
1. Use `chrome.scripting.registerContentScripts` with `persistAcrossSessions: false` — re-registers on extension load
2. Use programmatic injection on extension reload
3. Accept the limitation and document it

### Best practice for re-injection
```js
// background.js — on WebSocket connect
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {action: "ping"});
  } catch {
    // Content script not loaded, inject it
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  }
}
```
