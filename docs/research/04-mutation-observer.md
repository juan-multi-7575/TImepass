# MutationObserver — Research Findings

Source: https://javascript.info/mutation-observer

## Syntax

```js
let observer = new MutationObserver(callback);
observer.observe(node, config);
```

## Config Options

| Option | Description |
|--------|-------------|
| `childList` | Observe direct children additions/removals |
| `subtree` | Observe all descendants |
| `attributes` | Observe attribute changes |
| `attributeFilter` | Array of specific attribute names to watch |
| `characterData` | Observe text content changes |
| `attributeOldValue` | Pass both old and new attribute values |
| `characterDataOldValue` | Pass both old and new text values |

## MutationRecord Properties

- `type` — "attributes", "characterData", or "childList"
- `target` — where the change occurred
- `addedNodes` / `removedNodes` — nodes added/removed
- `previousSibling` / `nextSibling` — surrounding nodes
- `oldValue` — previous value (if options enabled)

## Performance Best Practices

### 1. Throttle Callbacks
```js
let lastRun = 0;
const MIN_INTERVAL = 100; // 10/sec max

const observer = new MutationObserver((records) => {
  const now = Date.now();
  if (now - lastRun < MIN_INTERVAL) return;
  lastRun = now;
  
  // Process mutations
  processRecords(records);
});
```

### 2. Use Specific Options (Don't Watch Everything)
```js
// BAD — watches everything, fires on any change
observer.observe(el, { childList: true, attributes: true, subtree: true });

// GOOD — only watch what you need
observer.observe(el, {
  childList: true,
  subtree: true,
  // Don't watch attributes unless needed
});
```

### 3. Disconnect When Done
```js
// Always disconnect when observation is no longer needed
observer.disconnect();
```

### 4. Batch Processing
```js
let pending = false;
const observer = new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    // Process all accumulated mutations
    pending = false;
  });
});
```

## Common Pitfalls

### 1. Infinite Loops
```js
// DANGER: observer modifies DOM, triggering more mutations
observer.observe(el, { childList: true, subtree: true });
el.appendChild(newNode); // Triggers observer callback!

// FIX: Disconnect before modifying
observer.disconnect();
el.appendChild(newNode);
observer.observe(el, config);
```

### 2. Stale References
```js
// BAD: element reference may become stale
const target = document.querySelector('.dynamic-element');
observer.observe(target, { childList: true });

// GOOD: observe parent, filter in callback
observer.observe(parentEl, { childList: true, subtree: true });
```

### 3. Memory Leaks
```js
// BAD: observer never disconnected
function setup() {
  const observer = new MutationObserver(callback);
  observer.observe(el, config);
  // observer is never cleaned up
}

// GOOD: return disconnect function
function setup() {
  const observer = new MutationObserver(callback);
  observer.observe(el, config);
  return () => observer.disconnect();
}
```

## Relevance to timepass

### Current issue
`startResponseStream` creates a MutationObserver that:
1. Runs `findResponseEl()` on EVERY mutation (expensive querySelectorAll chain)
2. No throttling — unbounded firing during streaming
3. Observer may not be properly disconnected when new stream starts

### Recommended fix
```js
function startResponseStream(id) {
  // Disconnect any prior observer
  if (window.__timepass_activeMutationObserver) {
    window.__timepass_activeMutationObserver.disconnect();
    window.__timepass_activeMutationObserver = null;
  }

  let lastRun = 0;
  const MIN_INTERVAL = 100; // 10/sec max

  const observer = new MutationObserver(() => {
    const now = Date.now();
    if (now - lastRun < MIN_INTERVAL) return;
    lastRun = now;
    
    const el = findResponseEl();
    if (!el || !el.isConnected) return;
    const text = el.innerText || "";
    emit(text);
  });

  // ... rest of setup
}
```
