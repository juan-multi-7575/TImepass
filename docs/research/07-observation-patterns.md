# Observation Patterns — Cloned Repos Analysis

## ego-lite: The Best Pattern

### waitForFunction (Polling)
```ts
async function waitForFunction(pageFunction, options = {}) {
  const timeout = options.timeout ?? state.defaultTimeout;
  const polling = options.polling ?? 100;
  const deadline = state.now() + timeout;
  while (state.now() < deadline) {
    const response = await cdp("Runtime.evaluate", {
      expression: buildWaitForFunctionExpression(pageFunction),
      returnByValue: true,
      awaitPromise: true,
    });
    const value = runtimeValue(response);
    if (value) return value;
    await state.sleep(polling);
  }
  return false; // timeout
}
```

### waitForNetworkIdle (Network-based)
```ts
async function waitForNetworkIdle(options = {}) {
  const timeout = options.timeout ?? 10000;
  const idleMs = options.idleMs ?? 500;
  const deadline = state.now() + timeout;
  let lastActivity = state.now();
  const inflight = new Set();
  
  while (state.now() < deadline) {
    for (const event of await drainEvents()) {
      if (event.method === "Network.requestWillBeSent") {
        inflight.add(event.params.requestId);
        lastActivity = state.now();
      } else if (event.method === "Network.loadingFinished" ||
                 event.method === "Network.loadingFailed") {
        inflight.delete(event.params.requestId);
        lastActivity = state.now();
      }
    }
    // Idle = no inflight requests AND no activity for idleMs
    if (inflight.size === 0 && state.now() - lastActivity >= idleMs) {
      return true;
    }
    await state.sleep(100);
  }
  return false;
}
```

### Key Insight
ego-lite uses **network activity** to detect completion, not DOM mutations. This is more reliable because:
- Network idle = no more API calls = response is complete
- DOM mutations can continue after network completes (rendering)
- No need to guess when "settling" is done

## browser-use: Alternative Pattern

### DOM Watchdog
- Uses `performance.getEntriesByType('resource')` to detect pending requests
- Checks `document.readyState` for page load
- Network-based, not MutationObserver-based

### Stream Events
- `model.stream_delta` — incremental text updates
- `model.response.output_item` — complete response chunks
- Event-driven, not polling

## Recommended Pattern for timepass

### Hybrid Approach (Best of Both)

1. **waitForElement** — poll until response element exists (like ego-lite's waitForFunction)
2. **Network idle detection** — wait until no network requests for N ms (like ego-lite's waitForNetworkIdle)
3. **Settling timeout** — if network idle doesn't fire, use a settling window (mutations stop for N ms)

### Implementation

```js
// In content.js — universal observe command
async function observeResponse(config) {
  const { selectors, timeout = 30000, idleMs = 1500 } = config;
  
  // Step 1: Wait for response element to appear
  const el = await waitForElement(selectors, { timeout });
  if (!el) return { error: "Response element not found" };
  
  // Step 2: Stream mutations until settling
  return new Promise((resolve) => {
    let lastMutation = Date.now();
    let lastText = "";
    
    const observer = new MutationObserver(() => {
      const text = el.innerText || "";
      if (text !== lastText) {
        lastText = text;
        lastMutation = Date.now();
        // Post stream delta
        postMessage({ type: "stream_delta", text });
      }
    });
    
    observer.observe(el, { childList: true, characterData: true, subtree: true });
    
    // Step 3: Check for settling every 100ms
    const checkSettle = setInterval(() => {
      if (Date.now() - lastMutation >= idleMs) {
        // Settled — response is complete
        observer.disconnect();
        clearInterval(checkSettle);
        postMessage({ type: "turn_complete", text: lastText });
        resolve({ text: lastText });
      }
    }, 100);
    
    // Step 4: Hard timeout safety net
    setTimeout(() => {
      observer.disconnect();
      clearInterval(checkSettle);
      postMessage({ type: "turn_complete", text: lastText });
      resolve({ text: lastText });
    }, timeout);
  });
}

// Universal waitForElement
async function waitForElement(selectors, options = {}) {
  const { timeout = 10000, polling = 200 } = options;
  const deadline = Date.now() + timeout;
  
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el && el.isConnected && el.offsetHeight > 0) {
          return el;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, polling));
  }
  return null;
}
```

### Why This Works

1. **No timeout waste** — if response arrives in 2s, we detect settling at 3.5s (2s + 1.5s idle), not 30s
2. **No premature completion** — network idle ensures all API calls finished
3. **Handles slow responses** — hard timeout is a safety net, not the primary mechanism
4. **Universal** — works for any site, not just Gemini

### Gemini-Specific Config

```json
{
  "observe": {
    "selectors": ["model-response", "[class*='model-response']"],
    "exclude": ["[class*='tts']", "[class*='visually-hidden']"],
    "idleMs": 1500,
    "timeout": 30000
  }
}
```
