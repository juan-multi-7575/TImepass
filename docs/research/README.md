# Research Findings — Browser Automation Architecture

## Files

| File | Topic | Key Finding |
|------|-------|-------------|
| 01-message-passing.md | Chrome MV3 messaging | Return `true` for async, use ports for streaming |
| 02-content-scripts.md | Content script injection | Use `registerContentScripts` for auto re-injection |
| 03-selector-strategies.md | DOM selector priority | Role > Label > Text > CSS (Playwright pattern) |
| 04-mutation-observer.md | MutationObserver patterns | Throttle to 10/sec, disconnect when done |
| 05-extension-performance.md | Extension CPU optimization | Rate limit logs, exponential backoff, throttle observers |

## Key Architecture Decisions

### 1. Per-Site Adapter Registry (NOT universal DOM engine)
Every successful multi-site Chrome extension uses per-domain adapter maps:
- PromptVault, claude-a11y, Chat-Key-Changer — all hardcoded per-site
- browser-use uses LLM-based discovery (different approach, higher cost)
- **Recommendation:** Keep per-site adapters, make them data-driven

### 2. Selector Priority
```
ARIA role/label (0.90) → data-testid (0.95) → text (0.80) → CSS class (0.60)
```

### 3. Message Passing
- One-shot commands: `chrome.tabs.sendMessage()` with `return true`
- Streaming responses: `chrome.tabs.connect()` ports
- Rate limit all messages to prevent WebSocket flood

### 4. Performance
- Max 20 forwarded logs/sec
- Exponential backoff for reconnection
- MutationObserver throttled to 10/sec
- Disconnect observers when not needed

## Recommendations for timepass

1. **Refactor content.js to use per-site adapter registry**
   - Move Gemini selectors to a config object
   - Make the extension a thin relay (generic find/type/click/observe ops)
   - CLI carries Gemini-specific knowledge

2. **Use ports for streaming**
   - Keep `sendMessage` for one-shot commands
   - Use `chrome.tabs.connect()` for response streaming
   - Avoid the async response timing issues

3. **Implement selector fallback chains**
   - Try ARIA/role first, CSS last
   - Filter out hidden/visually-hidden elements
   - Score selectors by reliability
