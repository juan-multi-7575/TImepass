# Chrome Extension Performance — Research Findings

Source: https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle

## Service Worker Lifecycle

### Idle and Shutdown
Chrome terminates a service worker when:
- After **30 seconds of inactivity** (receiving events or calling APIs resets timer)
- A single request takes longer than **5 minutes**
- A `fetch()` response takes more than **30 seconds**

### Keep-Alive Mechanisms
Events and API calls reset the idle timer. Specifically:
- WebSocket connections extend lifetime (Chrome 116+)
- `chrome.debugger` sessions keep alive (Chrome 118+)
- `chrome.alarms` can set minimum 30s period (Chrome 120+)

## Performance Anti-Patterns

### 1. Console Log Flooding
```js
// BAD — forwards EVERY console call
const originalLog = console.log;
console.log = (...args) => {
  originalLog.apply(console, args);
  chrome.runtime.sendMessage({type: "log", text: args.join(" ")});
};
```

**Impact:** Gemini's SPA logs hundreds of messages/sec → WebSocket flood → CPU spike

### 2. Unbounded Reconnection
```js
// BAD — no backoff, polls every 2s forever
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWebSocket();
  }
}, 2000);
```

### 3. MutationObserver Without Throttling
```js
// BAD — fires on EVERY DOM change
const observer = new MutationObserver((records) => {
  processRecords(records); // Expensive DOM queries
});
```

## Performance Best Practices

### 1. Rate Limiting
```js
const MAX_LOGS_PER_SEC = 20;
let logCount = 0;
let lastLogReset = Date.now();

function sendLog(text) {
  const now = Date.now();
  if (now - lastLogReset > 1000) {
    logCount = 0;
    lastLogReset = now;
  }
  if (logCount >= MAX_LOGS_PER_SEC) return;
  logCount++;
  chrome.runtime.sendMessage({type: "log", text});
}
```

### 2. Exponential Backoff
```js
let reconnectAttempts = 0;
const MAX_BACKOFF_MS = 30000;

function scheduleReconnect() {
  const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
  reconnectAttempts++;
  setTimeout(connectWebSocket, delay);
}
```

### 3. MutationObserver Throttling
```js
let lastMutationTime = 0;
const MIN_MUTATION_INTERVAL = 100; // 10/sec

const observer = new MutationObserver(() => {
  const now = Date.now();
  if (now - lastMutationTime < MIN_MUTATION_INTERVAL) return;
  lastMutationTime = now;
  processMutations();
});
```

### 4. Persistent Storage
```js
// BAD — global variables lost on service worker shutdown
let ws = null;
let pendingRequests = new Map();

// GOOD — use chrome.storage for critical state
chrome.storage.local.set({wsState: 'connected'});
```

## CPU Optimization Checklist

- [ ] Rate limit console log forwarding (max 20/sec)
- [ ] Use exponential backoff for reconnection
- [ ] Throttle MutationObserver callbacks (max 10/sec)
- [ ] Disconnect observers when not needed
- [ ] Avoid polling — use event-driven patterns
- [ ] Minimize DOM queries in hot paths
- [ ] Use `requestAnimationFrame` for visual updates
- [ ] Batch processing for multiple mutations

## Relevance to timepass

### Root cause of >50% CPU
1. **Console log flooding** — Gemini logs hundreds of messages/sec, all forwarded via WebSocket
2. **No backoff** — reconnection polls every 2s unconditionally
3. **Unbounded MutationObserver** — fires on every DOM change during streaming

### Fixes applied (commit 561d0aa)
- Rate limited console forwarding to 20/sec
- Added exponential backoff (2s → 4s → 8s → 16s → 30s max)
- Throttled MutationObserver to ~10/sec
