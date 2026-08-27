# WaitForElement Patterns — Cloned Repos Analysis

## crawl4ai: MutationObserver-based waitForElement

```javascript
const waitForElement = (selector, timeout = 10000) => new Promise((resolve, reject) => {
  const el = document.querySelector(selector);
  if (el) return resolve(el);  // already exists — immediate return
  
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
    reject(new Error(`Timeout waiting for ${selector}`));
  }, timeout);
});
```

**Key insight:** Check immediately before observing. If element exists, return instantly — no need to wait for mutations.

## ego-lite: internal:last locator

```typescript
// Parses selectors like "internal:last;button[aria-label='Copy']"
const lastMatch = /^internal:last;([\s\S]+)$/.exec(value);
if (lastMatch) {
  nth = "last";
  value = lastMatch[1];
}
```

**Key insight:** `internal:last;` prefix means "take the last match from querySelectorAll". This is exactly what we need for "last response-container".

## Recommended Implementation for timepass

### Universal waitForElement (from crawl4ai)
```javascript
function waitForElement(selector, timeout = 30000) {
  return new Promise((resolve, reject) => {
    // Immediate check
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    
    // MutationObserver for dynamic appearance
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
      reject(new Error(`Timeout: ${selector} not found in ${timeout}ms`));
    }, timeout);
  });
}
```

### Universal observeResponse (Gemini-specific)
```javascript
async function observeResponse(config) {
  const { 
    responseSelector = 'response-container:last-child',
    completionSelector = 'button[aria-label="Copy"]',
    errorSelectors = ['[role="alert"]', '[class*="error"]'],
    timeout = 60000 
  } = config;
  
  // Wait for response container to appear
  const responseEl = await waitForElement(responseSelector, timeout);
  
  // Wait for completion signal (copy button)
  const copyBtn = await waitForElement(
    `${responseSelector} ${completionSelector}`, 
    timeout
  );
  
  // Check for errors
  for (const errSel of errorSelectors) {
    const errEl = responseEl.querySelector(errSel);
    if (errEl && errEl.innerText.trim()) {
      throw new Error(`Gemini error: ${errEl.innerText.trim()}`);
    }
  }
  
  // Return response text
  return responseEl.innerText.trim();
}
```

### Why this works
1. **No wasted time** — if response arrives in 2s, we detect it at 2s (MutationObserver fires immediately)
2. **No premature completion** — we wait for copy button, not just any mutation
3. **Error detection** — checks for error UI before returning
4. **Universal** — works for any site with the right config
