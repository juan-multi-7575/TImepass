# Workstream C — API cleanup & security findings

**source set**: minimal-change-engineer  
**agent name**: Minimal Change Engineer  
**finding**: Completed requested cleanup/safety work and verified with typecheck/lint; one remaining extension warning is intentionally left because the unused symbol is still externally referenced outside `extension/*.js`.  
**evidence**:
- `src/adapter/gemini-adapter.ts:25` canonical `model` is used first, `modelId` is accepted as fallback; `src/adapter/types.ts:3` docs the alias as backward-compatible.  
- `extension/content.js:682` history read now scopes to sidebar containers before querying links.  
- `extension/content.js:687` readHistory returns structured failure objects.  
- `extension/content.js:704` selectHistory now searches the same sidebar-scoped links.  
- `extension/background.js:289` click_button validates `payload.selector` and returns structured error before dispatch.  
- `extension/background.js:657` fixed undefined `message` by using the listener parameter instead of `_message`.  
- `src/driver/extension-driver.ts:45` typed WebSocket server error handler to satisfy `err.code` typecheck.  
- `npm run typecheck` passes.  
- `npm run lint` passes with 0 errors; 1 warning remains at `extension/content.js:847` for `serializeSubtree`, which is unused in `extension/*.js` but referenced in docs/MCP description (`src/mcp/tools.ts:9`), so safe removal is blocked by external discovery and is deferred.  

Follow-ups not completed: remove/rename `serializeSubtree` only after confirming no callers need the exported symbol name.
