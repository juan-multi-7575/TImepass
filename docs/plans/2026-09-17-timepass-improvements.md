# Timepass Improvements Plan

**Date:** 2026-09-17  
**Scope:** correctness cleanup, reliability/streaming, API hygiene, and security hardening  
**Workstreams:** A — correctness cleanup, B — reliability & streaming, C — API cleanup & security

---

## Findings Summary

### Critical
- Inverted guard in `extension/content.js:784`: `if (payload || !payload.text)` always passes.
- `src/driver/cdp-driver.ts` is a stub; any CDP flow silently succeeds without doing work.
- `RetryHandler` is constructed in `GeminiAdapter` but never used.

### High
- `ExtensionDriver.connect()` resolves before the Chrome client connects, so early failures are silent.
- `file_upload` depends on `chrome.debugger`, which fails if DevTools is open.
- Model switching is disabled in `content.js`, but `GeminiOptions.model` is still accepted as if it works.

### Medium
- `simulateTyping` uses fixed-interval text injection that may not fully trigger editor behavior.
- `readHistory` selector `a[href*="/app/"]` is overly broad.
- `PromptInputHandler.execute()` sets `innerHTML` directly without sanitization.
- Pre-flight probe in `background.js` uses `fetch(..., { mode: "no-cors" })`, which can’t reliably detect offline state.

### Low
- `getMimeType` in `src/cli.ts` is defined but never called.
- `GeminiOptions` exposes both `model` and `modelId`, creating API ambiguity.
- Lint warnings in extension JS include several intentionally-shaped patterns.

---

## Workstream A — Correctness Cleanup

**Goal:** remove dead paths, fix broken logic, and make startup behavior explicit.

### Tasks
1. Fix inverted guard in `extension/content.js:784`.
2. Remove unused `getMimeType` from `src/cli.ts`.
3. Decide `RetryHandler` fate:
   - preferred: wire it into `GeminiAdapter` action execution
   - fallback: remove `RetryHandler` and `maxRetries` option to reduce dead surface
4. Resolve `CdpDriver`:
   - preferred: remove from public exports if not supported
   - fallback: implement minimal CDP action dispatch

### Acceptance
- `npm run typecheck` passes.
- `npm test` passes.
- Inverted guard covered by behavior expectation or removed dead path.
- No unused exported driver path that silently no-ops.

---

## Workstream B — Reliability & Streaming

**Goal:** make the extension bridge and response observation more robust, and make `stream` actually stream.

### Tasks
1. Implement true streaming in `ExtensionDriver` and `GeminiAdapter.stream`:
   - register `stream_delta` listener
   - forward chunks to `onChunk`
   - finalize on `turn_complete`
2. Harden `observeResponse`:
   - prefer `MutationObserver`/narrow response-container watching
   - keep broad fallback polling only as a secondary path
   - reduce snapshot cost and poll frequency on stable pages
3. Make `ExtensionDriver.connect()` behavior explicit:
   - reject or expose a `ready` flag when no Chrome client connects
4. Add configurable WebSocket port with conflict handling:
   - default remains `9876`
   - try alternate port or surface clear error on `EADDRINUSE`
5. Add lightweight action payload validation at the driver boundary:
   - required `action` type check
   - payload shape guard for known actions

### Acceptance
- `npm run typecheck` passes.
- `npm test` passes.
- `stream` emits chunks before final completion instead of waiting for full response.
- Connection failure is observable without reading log text.

---

## Workstream C — API Cleanup & Security

**Goal:** tighten public API, reduce ambiguity, and harden inputs in the extension.

### Tasks
1. Unify model option:
   - keep `model` as the canonical field
   - accept `modelId` as a backward-compatible alias internally
2. Sanitize selector/cookie inputs:
   - validate `payload.selector` in `click_button`
   - validate cookie restore domain/path shape before calling `chrome.cookies.set`
3. Tighten `readHistory`:
   - scope selector to sidebar history container instead of global `a[href*="/app/"]`
4. Review lint warnings in `extension/`:
   - fix clear unused-vars issues
   - add comments or eslint-disable only for intentional patterns
5. Reduce silent failures:
   - do not swallow all re-injection errors silently
   - return structured errors for known failure modes

### Acceptance
- `npm run typecheck` passes.
- `npm run lint` passes or has intentional warnings with documented justification.
- `readHistory` no longer scans the entire document for history links.
- Selector-based actions fail with a clear error instead of throwing raw message-channel exceptions.

---

## Verification Steps

1. Run `npm run typecheck`
2. Run `npm test`
3. Run `npm run lint`
4. Review changed files for unintended scope expansion
