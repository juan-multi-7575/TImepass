# Code & Bug Review — `timepass`

**Scope:** `src/` (2,000 lines TS), `extension/` (2,060 lines JS), plus repo hygiene — **Part I**. `dsh-plugin/` (1,700 lines, the agent-facing Cordis plugin) — **Part II**.
**Method:** full read of every source file, `tsc --noEmit`, `eslint`, `vitest` (83/83 pass), plus a throwaway runtime harness that exercised 12 behavioural claims. Claims below marked **verified** were reproduced at runtime; the rest are traced statically.
**Baseline:** `tsc` clean, `eslint extension/` clean, 83/83 tests green. The bugs below are all in paths the existing tests do not cover.

---

## Summary

| # | Sev | Finding | Location |
|---|-----|---------|----------|
| 1 | CRITICAL | `--new-chat` is a silent no-op — prompts land in the existing conversation | `background.js:134-157` |
| 2 | CRITICAL | Live session cookies and `node_modules` are committed; no `.gitignore` exists | repo root |
| 3 | HIGH | Caller's action timeout is never honoured; every action is capped at 60s | `extension-driver.ts:149` |
| 4 | HIGH | Re-injection registers a second message listener → prompt typed and sent twice | `background.js:239-252` |
| 5 | HIGH | Reconnect storm opens duplicate sockets; a stale close disconnects a live one | `background.js:661-670` |
| 6 | HIGH | `askWithFiles` verification step cannot fail — it checks the wrong thing | `gemini-adapter.ts:329-336` |
| 7 | HIGH | Freeze recovery's own timeline nearly exceeds the budget that must absorb it | `background.js:679-747` |
| 8 | HIGH | MCP `browser_observe` advertises an observer it does not implement | `mcp/tools.ts:7,28-32` |
| 9 | MED | `ask-with-files` parses `--model pro` as file paths | `cli.ts:238` |
| 10 | MED | `--timeout` is recommended by the error text but is never a flag | `cli.ts:21` |
| 11 | MED | Cookie restore deletes the session before validating the replacement | `background.js:773-794` |
| 12 | MED | `dom_dump` has no size cap; a bad selector loses the real error | `content.js:1101-1145` |
| 13 | MED | `executeAction` never clears its timer → leak, and the MCP server can't exit | `extension-driver.ts:159` |
| 14 | MED | `connect()` is a one-shot race with no reconnect | `extension-driver.ts:120-127` |
| 15 | MED | `tab-switch` has no effect; screenshots hijack the user's window | `background.js:136,270` |
| 16 | MED | A turn can be declared complete mid-pause and returned as `partial: false` | `content.js:406,449-460` |
| 17 | MED | Broad phase can stream the *previous* answer as the opening delta | `content.js:475-495` |
| 18 | MED | `dom_snapshot`'s `maxDepth` is advertised but never forwarded | `mcp/tools.ts:9` |
| 19 | MED | MCP swallows connect failure and never releases port 9876 | `mcp/server.ts:7-29` |
| 20 | MED | `AdaptiveStore.relocate()` scores every document node, synchronously | `adaptive/store.ts:210` |
| 21 | LOW | ~765 lines of write-only dead code; `driver:'cdp'` ignored | `src/components/*` |
| 22 | LOW | `offEvent` leaks empty listener entries | `extension-driver.ts:175-181` |
| 23 | LOW | `isVisible()` misreads `position: fixed` as hidden | `answer-root.js:26-28` |
| 24 | LOW | Over-broad permissions; `contextMenus` declared but unused | `manifest.json:4-18` |
| 25 | LOW | README documents an implementation that no longer exists | `README.md:14` |
| D1 | HIGH | Plugin `timeoutMs` default (120s) exceeds the hard 75s cap; rendered answers dropped | `dsh-plugin/src/tools.js:209` |
| D2 | HIGH | Disposing mid-connect leaks port 9876 for the life of the process | `bridge.js:155-175,325-336` |
| D3 | MED | Freeze-recovery answer is discarded; `recovered` hard-wired false | `background.js:730` → `gemini-adapter.ts:83` |
| D4 | MED | Cookie backup written `0644` to an unignored path | `lib/artifacts.js:20` |
| D5 | MED | Negative `timeoutMs` accepted → instant empty `partial` answer | `dsh-plugin/src/tools.js:209` |
| D6-9 | LOW | Artifact write failure loses the answer; unbounded read; dead branch | `dsh-plugin/src/` |
| **S1** | — | **Implemented:** `gemini_session` preflight tool + session identity on every ask | `dsh-plugin/src/tools.js`, `lib/session.js` |

---

## CRITICAL

### 1. `--new-chat` silently does nothing
**`extension/background.js:134-157`** · confidence: HIGH (grep-verified)

The adapter sets `payload.url = 'https://gemini.google.com/app'` for `newChat`, and `getOrCreateGeminiTab(targetUrl)` receives it — but `targetUrl` is consumed **only** by `chrome.tabs.create` on line 141. When a Gemini tab already exists (the normal case, since the extension pins one at startup), nothing navigates it:

```js
async function getOrCreateGeminiTab(targetUrl = "https://gemini.google.com/app") {
  const tabs = await chrome.tabs.query({ url: "https://gemini.google.com/*" });
  let tab = tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: targetUrl, ... });   // only here
  } else if (tab.discarded || tab.status === "loading") { ... }  // never navigates
```

There is no `chrome.tabs.update(tab.id, { url })` anywhere in the extension (grep-verified across all files).

**Symptom:** `timepass ask "..." --new-chat` and the MCP `browser_ask` with `newChat: true` continue the *previous* conversation. The agent believes it has a clean context; it has silently appended. This is the worst class of bug here — no error, wrong answer.

**Fix:** in the `else` branch, `if (targetUrl && tab.url !== targetUrl) await chrome.tabs.update(tab.id, { url: targetUrl });` before `waitTabLoaded`. Note the fix also needs to wait for the navigation to complete, since `inject_and_send` types into the composer immediately.

### 2. Live session cookies and `node_modules` are committed; there is no `.gitignore`
**repo root** · confidence: HIGH (git-verified)

`git ls-files` shows `cookies.json`, `screenshot.png`, `history.json`, `response.md`, 68 files under `dist/`, and **2,164 files under `node_modules/`**. No `.gitignore` exists.

`cookies-get` dumps *every* cookie for the domain — including `__Secure-1PSID`/`__Secure-1PSCT` session tokens (`background.js:756-770`). The committed copy currently holds only analytics cookies (`_ga`, `COMPASS`), so nothing has leaked *yet*, but the next `cookies-get` on a logged-in session commits live credentials. `git status` also shows `cookies.json` as tracked and the tree already carries session-derived output.

**Fix:** add a `.gitignore` (`node_modules/`, `dist/`, `cookies.json`, `screenshot.png`, `history.json`, `response.md`, `dom-tree.json`, `response.md`, `.timepass/`), `git rm --cached` those paths, and — since the file has a git history — rotate the Gemini session if any real token was ever captured. Consider writing cookies to an OS-restricted path outside the repo.

---

## HIGH

### 3. The caller's timeout is read at the wrong level, so every action is capped at 60s
**`src/driver/extension-driver.ts:149`** · confidence: HIGH (**verified at runtime**)

The driver honours a per-action budget from the **top level** of the `ActionPayload`:

```ts
const budget = typeof (payload as any).timeoutMs === 'number' && ... ? (payload as any).timeoutMs
  : DEFAULT_ACTION_BUDGET_MS;
```

But `GeminiAdapter.ask()`/`stream()` nest it one level down (`{ action, payload: { prompt, model, timeoutMs } }`). Runtime check: the key the driver reads is absent from the adapter's actual message.

`ActionPayload` (`driver.interface.ts:1-6`) has no `timeoutMs` field at all — which is why the driver's own tests need `as any` to set it (`extension-driver.test.ts:28`). **The test suite validates a message shape production never sends**, so the bug is invisible to CI.

**Symptom:** every ask is abandoned at 60s+15s regardless of the caller's request. A long answer is lost even though the page was still producing it — the exact failure the `ACTION_GRACE_MS` comment says it exists to prevent.

**Fix:** add `timeoutMs?: number` to `ActionPayload` and have the adapter set it at the top level; keep `payload.timeoutMs` for the page-side budget. Then add a test that drives `GeminiAdapter.ask()` through a fake driver and asserts the budget it forwarded.

### 4. Re-injection registers a second message listener → the prompt is typed and sent twice
**`extension/background.js:239-252` + `content.js:944`** · confidence: HIGH

`content.js` guards its listener with `window.__timepass_listener_registered`. The recovery path **resets that flag first**, then re-injects the file:

```js
await chrome.scripting.executeScript({ target: { tabId }, func: () => { window.__timepass_listener_registered = false; } });
await chrome.scripting.executeScript({ target: { tabId }, files: ["answer-root.js", "content.js"] });
```

The original listener from the `document_idle` injection is still attached to `chrome.runtime.onMessage` — resetting a flag cannot unregister it. `executeScript` runs in the same isolated world, so the page now has **two** listeners. Every action is then handled twice: `inject_and_send` runs `simulateTyping` twice into the same composer and clicks Send twice.

**Symptom:** after any reconnect (the common case — a discarded tab, a reload, the service worker restarting), the prompt appears duplicated in the composer and the turn fires twice. It is also a double `sendResponse` on one channel, which Chrome resolves by dropping one reply — so the surviving reply may be from the losing listener.

**Fix:** make the guard *self-sufficient* rather than resettable. Have `sendMessageWithRetry` check liveness first (`chrome.tabs.sendMessage` with a `get_status` ping) and only re-inject when no listener answers; when re-injecting, do **not** clear the flag — let the existing listener keep serving, and have the injected file exit early. Alternatively register a single listener on a `window`-scoped object and look the handler up through it, so re-injection replaces rather than appends.

### 5. Reconnect storm opens duplicate sockets; a stale close disconnects a live one
**`extension/background.js:661-670` + `extension-driver.ts:106-110`** · confidence: HIGH

The 2s interval schedules a **new, independent, never-cancelled** `setTimeout` on every tick while offline:

```js
} else {
  const backoffMs = Math.min(2000 * Math.pow(2, reconnectAttempts), MAX_BACKOFF_MS);
  reconnectAttempts++;
  setTimeout(() => connectWebSocket(), backoffMs);
}
```

The backoff is computed per *tick*, not per *attempt*, so it saturates at 30s within 5 ticks while new 30s timers keep being queued every 2s. `connectWebSocket` has no in-flight guard: its `if (ws)` check happens before an 800ms `await fetch(...)` pre-flight, so overlapping invocations all see `ws === null` and each creates its own `WebSocket`. The last one wins the global; the earlier ones stay open, orphaned.

The orphaned sockets then break the driver. Each connection fires the server's `close` handler, which nulls the socket **unconditionally** — with no check that it is still the current one:

```ts
ws.on('close', () => {
  this.clientSocket = null;   // nulls a *different*, still-live socket
});
```

**Symptom:** an orphaned socket closes → `clientSocket` is nulled → every subsequent action fails with *"Extension not connected over WebSocket bridge"* while the extension's own socket is connected and its popup badge may still read "Disconnected". This is intermittent and looks like a flaky extension.

**Fix:** (a) keep one `reconnectTimer` handle and clear it before scheduling; (b) add a `connecting` boolean guard to `connectWebSocket`; (c) in the driver, capture the socket in the closure and only clear `clientSocket` if it is still the same instance.

### 6. `askWithFiles` verification cannot fail — it checks the wrong thing
**`src/adapter/gemini-adapter.ts:329-336` + `content.js:1088`** · confidence: HIGH

After uploading, the adapter "verifies" the files are attached:

```ts
const verifyRes = await this.driver.executeAction({ action: 'get_page_info' });
if (!verifyRes.success || verifyRes.data?.fileInputs === 0) {
  throw new Error('File upload verification failed: no file inputs found after upload.');
}
```

But `fileInputs` is a static, document-wide count of input elements:

```js
fileInputs: document.querySelectorAll("input[type='file']").length,
```

It counts inputs that exist whether or not anything was ever attached. Gemini keeps its (hidden) file input mounted at all times, so this count is essentially constant and the check passes even if every upload silently failed. The guard gives false assurance at exactly the point the pipeline needs it.

**Fix:** verify what actually matters — the attachment chips/previews in the composer, or `input.files.length` on the resolved input. Return the *delta* (post-upload count minus the count taken before the upload) rather than an absolute page count.

### 7. Freeze recovery's own timeline nearly exceeds the budget meant to absorb it
**`extension/background.js:679-747` + `extension-driver.ts:152`** · confidence: HIGH

The watchdog treats 20s of heartbeat silence as a freeze, then reloads and waits for recovery:

```
20s silence  →  chrome.tabs.reload  →  waitTabLoaded (up to 40 × 200ms = 8s)
             →  recover_last_response (up to 45s)
             =  up to 73s
```

The driver's budget for that same `inject_and_send` is `timeoutMs + ACTION_GRACE_MS` = 60 + 15 = **75s**. The recovery path consumes 97% of the window it must finish inside, with no margin for a slow reload or a late `sendMessageWithRetry` round trip.

**Symptom:** when the watchdog fires at all — precisely when the page is already unhealthy — the adapter is likely to throw "Action execution timed out after 75000ms" and discard an answer the recovery path was about to deliver. The recovery feature fails hardest exactly when it is needed.

**Fix:** make the budget recovery-aware. When arming `activeTurn` for `inject_and_send`, raise the driver budget by the worst-case recovery window (or have the watchdog's in-flight state signal the driver to extend the deadline). Also shorten `recover_last_response`'s default from 45s, since 6 stable samples at 500ms already implies the page has settled.

### 8. MCP `browser_observe` advertises an observer it does not implement
**`src/mcp/tools.ts:7, 28-32`** · confidence: HIGH

Declared: *"Observe current Gemini response until complete (broad diff + copy signal)"* with a `timeoutMs` and `settleMs` schema. Implemented:

```js
case 'browser_observe': {
  // Re-use ask with empty prompt? Instead trigger getPageInfo + dom snapshot polling via adapter if needed
  const info = await ada.getPageInfo();
  return info;
}
```

Both parameters are discarded and no observation happens — the caller gets the page URL, title and element counts. An agent that calls this after `browser_ask` will read a page-info object as if it were a completed response.

**Fix:** either implement it (poll `dom_dump` on the response container until the copy signal appears) or remove the tool. Shipping a tool whose name and description promise observation is worse than not shipping it — the failure is silent and the output is confidently wrong.

---

## MEDIUM

### 9. `ask-with-files` parses CLI flags as file paths
**`src/cli.ts:238`** · confidence: HIGH (**verified**)
```ts
const filePaths = args.slice(2).map((p) => path.resolve(process.cwd(), p));
```
`timepass ask-with-files "q" a.png --model pro --new-chat` resolves to `['a.png', '--model', 'pro', '--new-chat']`, and the existence check at line 242 throws `File not found at: /…/--model`. The documented invocation with a model fails. **Fix:** filter tokens starting with `-` and consume `--model`'s value, as the `--model` parser at line 69 already does.

### 10. `--timeout` is recommended but does not exist
**`src/cli.ts:21`** · confidence: HIGH (grep-verified)
`warnIfPartial` tells the user *"Re-run with a longer --timeout to collect the remainder"*, but no `--timeout` parsing exists anywhere in the CLI (grep-verified). The advice cannot be followed, and per finding #3 the budget would be ignored even if it were parsed. **Fix:** parse `--timeout`, pass it into `GeminiAdapter`, and set it at the top level of the `ActionPayload`.

### 11. Cookie restore destroys the session before validating the replacement
**`extension/background.js:773-794`** · confidence: HIGH
`writeCookies` removes **every** existing cookie for the domain, then loops over the payload calling `chrome.cookies.set`. If any entry lacks the `host` field (a hand-edited file, or a dump from another tool), `set` throws — after the deletes have already landed. The user is logged out of Gemini with no way back, and the CLI's own catch only reports the first failure.

**Fix:** validate the entire payload (shape, required `name`/`host`, domain match) *before* removing anything; then set first and remove only the leftovers, so a failure never leaves the session empty.

### 12. `dom_dump` is unbounded, and a bad selector loses the real error
**`extension/content.js:1101-1145`, `background.js:205-228`** · confidence: HIGH
`serializeSubtree` caps depth at 10 but has no cap on node count, attribute count, or total size, and the default root is `document.body`. On Gemini that is a multi-megabyte JSON string pushed through `chrome.tabs.sendMessage`, serialised to disk, and (via MCP) into the agent's context. Separately, `document.querySelector(rootSelector)` on line 1143 throws `SyntaxError` for a malformed selector from inside the listener; `sendResponse` is never reached, so the caller gets the generic *"Content script returned no response for action: dom_dump"* instead of "invalid selector".

**Fix:** add a total-node/byte budget with an explicit `truncated: true` flag; wrap the selector lookup in `try/catch` and return the parse error as a normal `success: false` response.

### 13. `executeAction` never clears its timeout — leak, and a hung event loop
**`src/driver/extension-driver.ts:159-164`** · confidence: HIGH (**verified**: the 75 000 ms timer is still armed after the action resolves)
```ts
setTimeout(() => {
  if (this.pendingRequests.has(id)) { ... }
}, waitMs);
```
The callback self-guards but the timer itself is never cleared, so every completed action leaves a live 75s timer holding its closure. For the CLI this is invisible (`process.exit(0)`), but the MCP server has no such escape: see finding #19.

**Fix:** keep the handle and `clearTimeout` it in the reply path (`extension-driver.ts:90-95`), which already deletes the pending request.

### 14. `connect()` is a one-shot race with no reconnect
**`src/driver/extension-driver.ts:120-127`** · confidence: HIGH
After 10s without a client, `connect()` rejects. If the extension connects at second 11, the server accepts it, assigns `clientSocket`, and the promise is already settled — the caller got an error while the connection is live. Every later `executeAction` then works, so the failure is confusing rather than fatal. Worse, because the promise is already settled, a *subsequent* `connect()` call (if anyone made one) would create a second `WebSocketServer` on the same port and fail with `EADDRINUSE`.

**Fix:** keep the server alive after the connect timeout and reject only the caller; log that the connection arrived late. Add an explicit `close()` on timeout.

### 15. `tab-switch` has no effect; screenshots hijack the user's window
**`extension/background.js:136, 270-271`** · confidence: HIGH
`getOrCreateGeminiTab` always takes `tabs[0]`, so `tab_create`/`tab_switch` (both exposed by the CLI and `browser_tabs`) change nothing about which tab `ask` drives — a multi-tab workflow silently answers in the wrong conversation. Separately, `capture_screenshot` runs `chrome.windows.update(tab.windowId, { state: "maximized", focused: true })`, maximizing and stealing focus on the user's machine mid-task.

**Fix:** thread an explicit `tabId` through the action payload and have `getOrCreateGeminiTab` prefer it over `tabs[0]`; capture with `chrome.tabs.captureVisibleTab` on the target window without mutating window state, or gate the focus change behind a flag.

### 16. A turn can be declared complete mid-pause and returned as `partial: false`
**`extension/content.js:406, 449-460`** · confidence: MEDIUM
The narrow loop completes when the fingerprint is unchanged for `required` samples. The stop button is the strong signal, but it is *optional*: if it never appears (Google markup drift), the gate weakens to `STABLE_SAMPLES * 2` — 6s at the default cadence. Gemini's internal pauses (tool use, extended thinking) routinely exceed that, so a turn can be declared done mid-generation and the fragment returned with `partial: false`.

**Symptom:** a truncated answer that is indistinguishable from a complete one — precisely the failure the `partial` flag was introduced to prevent (`types.ts:31-39`, `cli.ts:15-23`).

**Fix:** require positive evidence of completion (a new copy button, the new clickable row) rather than falling back to elapsed stability alone; if only stability is available, mark the result `partial: true` with a distinct reason.

### 17. The broad phase can stream the previous answer as the opening delta
**`extension/content.js:475-495`** · confidence: MEDIUM
`extractor.extract` resolves the answer root via `findAnswerRoot()`, which returns the **last** `response-container`. The first poll after the narrow phase times out can precede the new container's render, so the root is still the *previous* turn's. That text is then emitted as `stream_delta` and becomes the adapter's `accumulatedText` baseline, after which the real answer is appended as a delta. `ask()` is unaffected (it uses the returned `text`), but the streamed output — which is what the DSH bridge surfaces — is prefixed with the old answer.

**Fix:** seed `streamedText` only from a container created after the send (the same `preSend` set the narrow phase already builds), and suppress deltas until that container exists.

### 18. `dom_snapshot`'s `maxDepth` is advertised but never forwarded
**`src/mcp/tools.ts:9`, `gemini-adapter.ts:227-239`** · confidence: HIGH
`dumpDom(selector?)` takes no `maxDepth` and sends only `{ selector }`, so the declared `maxDepth` parameter is silently ignored and depth 10 is always used. **Fix:** add the parameter to `dumpDom` and pass it through.

### 19. MCP swallows connect failure and never releases the port
**`src/mcp/server.ts:7-29`** · confidence: HIGH
```ts
await ada.connect().catch(() => {});   // failure is invisible
```
If port 9876 is already bound, the server starts anyway, permanently broken, with every tool call returning *"Extension not connected"* and no indication that the real problem is a port conflict. And nothing ever closes the adapter: the `WebSocketServer` holds the event loop, so when the MCP client disconnects the process does not exit and the port stays bound — the next launch then hits the failure above. **Fix:** surface the connect error (log to stderr, which is the MCP-safe channel), retry with backoff, and close the adapter when the stdio transport closes.

### 20. `AdaptiveStore.relocate()` scores every node in the document, synchronously
**`src/components/adaptive/store.ts:210-222`** · confidence: HIGH
```ts
const nodes: Element[] = [root, ...Array.from(root.querySelectorAll('*'))];
for (const node of nodes) { const score = similarityScore(fingerprint, node, root); ... }
```
For every candidate it calls `elementToDict`, which reads **all attributes** and `innerText` (a forced layout). That is O(N × depth) with a reflow per node, on the page's main thread, with no cap and no yielding. It is reached from `ElementResolver.tryAdaptive` on *every* failed resolve — i.e. precisely when the page is already not behaving as expected. The same pattern exists inline in `content.js:753-767`.

The module also `import`s `node:fs` (line 1) while being written against a browser `Element` API, so it cannot be bundled for the page it is designed to serve. **Fix:** prefilter by tag before scoring, read `textContent` instead of `innerText`, cap the candidate set, and move persistence behind an injected interface.

---

## LOW

**21. ~765 lines of write-only dead code, and an ignored `driver` option** — `ComponentRegistry` is populated in the constructor and read *nowhere*; `registerComponent()` is a public API with no effect (`gemini-adapter.ts:42-56`, grep-verified). Unreferenced by any production path: `retry-handler.ts`, `cdp-driver.ts`, `stealth-patcher.ts`, `dom-service.ts`, `element-resolver.ts`, `adaptive/store.ts`, and the five `ComponentHandler` implementations. Several reference `document`/`getComputedStyle` in a Node package and would throw if ever invoked. Separately, `driver: 'cdp'` is accepted and ignored — `new ExtensionDriver()` is hardcoded (line 41, **verified**) while `CdpDriver.executeAction` returns `{ success: true, data: undefined }` (`cdp-driver.ts:16-19`). Also, an explicit `model: undefined` overwrites the computed default (`gemini-adapter.ts:31-39`, **verified**). *Fix:* delete the unused layer, or wire it up; reject `driver: 'cdp'` until it is implemented.

**22. `offEvent` leaks listener entries** — `extension-driver.ts:175-181`. Removing the last of several listeners leaves an empty array; calling it for an event that was never registered creates a phantom entry. The single-listener delete path does work (I initially suspected it did not — corrected by runtime check). *Fix:* return early when the filter yields nothing.

**23. `isVisible()` misreads `position: fixed` as hidden** — `answer-root.js:26-28`. `offsetParent` is `null` for fixed-position elements, so a fixed or sticky copy button is treated as invisible. With exactly one copy button, `commonAncestorOf` (lines 35-40) then returns that button's *action row* as the "answer root" — too small — and `readAnswerText` yields a fragment. *Fix:* use `getClientRects().length` plus a computed-style check, and require the ancestor to contain the text too.

**24. Over-broad permissions; `contextMenus` is declared but unused** — `manifest.json:4-18` requests `<all_urls>` plus `cookies`, `debugger`, `tabs` for an extension that only ever drives `gemini.google.com`. `contextMenus` has no corresponding code (grep-verified). *Fix:* narrow `host_permissions` to `https://gemini.google.com/*`, drop `contextMenus`.

**25. README documents an implementation that no longer exists** — `README.md:14` advertises *"Drag-and-Drop File Upload … using simulated HTML5 `DragEvent` drops"*; there is no `DragEvent` or `DataTransfer` anywhere in the extension (grep-verified) — uploads go through `chrome.debugger` + `DOM.setFileInputFiles`. Line 28 calls `content.js` a "MutationObserver"; the only occurrence is a vestigial `window.__timepass_activeMutationObserver = null` (`content.js:95-97`). It also claims "zero-dependency" while `ws` and the MCP SDK are runtime dependencies, omits `src/components/`, `src/mcp/`, and `dsh-plugin/` from the layout, and documents 5 of 21 commands.

---

## What is genuinely good

Not everything here needs work, and some of it is better than the surrounding code:

- **Partial answers are labelled, not hidden.** `partial` is threaded from the page timeout through `answer-root.timeoutOutcome`, the adapter, the types, and out to a stderr warning in the CLI that explicitly says *"Do not treat it as the full answer"* (`cli.ts:15-23`). The reasoning is written down at each hop. This is the right instinct and it is rare.
- **The completion heuristic is honest about its own evidence.** `CompletionHeuristic` requires the stop button to have been seen before trusting settle-time alone, and resets its stable-run counter across a blocked-page gap rather than reading the gap as stability (`content.js:270-275`, `452`). That is a subtle failure mode most implementations get wrong.
- **The stall-gap guard.** A wide poll gap means the page was blocked and proves nothing, so it discards the interval instead of counting it (`content.js:430-437`). Same reasoning in the freeze watchdog: silence, not slowness, is the signal.
- **Freeze recovery via reload, not re-ask.** Reloading and re-reading the saved conversation — rather than re-sending the prompt — is the right call, and the comment explaining why is precise.
- **Extraction reads the live DOM, not the snapshot.** `ResponseExtractor.extract` ignores the snapshot's stored text because node entries are capped at 200 characters (`content.js:350-353`). Having been bitten by that, the fix is documented in place.
- **The driver applies grace to late replies** rather than treating a slow-but-healthy turn as a failure (`ACTION_GRACE_MS`), which is the correct model for this transport. Its *wiring* is broken (finding #3) but the idea is right.
- **`answer-root.js` is a good architectural call** — the selection rule lives in an inert, injectable file precisely so it can be unit tested, and it carries 16 passing tests. That is the one place in the codebase where the test-before-bug relationship held.

---

---

# Part II — `dsh-plugin/` (1,700 lines, untracked)

The Cordis plugin that exposes `gemini_*` tools to the agent harness. Reviewed separately, because it is the surface the agent actually calls. `node --check` passes on all 13 files and its 48 tests pass — none of the following is covered by them.

Two of these were reproduced at runtime; I re-verified every line reference myself before including it.

### D1. HIGH — `timeoutMs` is a no-op, and the plugin's own default is already over the cap
**`dsh-plugin/src/tools.js:209` → `src/driver/extension-driver.ts:149`** · confidence: HIGH (reproduced end-to-end, independently of Part I #3)

This is the same defect as Part I #3 seen from the tool surface, but it carries extra damage worth stating separately:

- The plugin's declared default is `timeoutMs: Schema.number().default(120000)` (`config.js:38`) — **already above the 75s hard cap**, so this fires with no unusual input on any long ask.
- The page *does* receive `payload.timeoutMs` and keeps generating ([content.js:979](extension/content.js#L979)); when it finally replies, the driver has already deleted the pending request, so **a fully-rendered answer is silently dropped** and replaced by "Action execution timed out after 75000ms".
- It makes the plugin's own documented recovery loop useless — `SKILL.md:60-68` tells the model to "re-ask with `timeoutMs: 300000`", which cannot work.

Reproduction against `dist/`: `executeAction({action:'read_history', timeoutMs:800})` gave up at 15 807ms (honoured), while `executeAction({action:'read_history', payload:{timeoutMs:800}})` was still pending at 3 000ms. `adapter.ask('hi', {timeoutMs:300000})` likewise still pending at 4 000ms.

**Fix:** `executeAction({ action, payload, timeoutMs: opts.timeoutMs })` in `ask`/`stream` — with `timeoutMs` added to `ActionPayload` so the cast is not needed — and bound `runAsk` with `withTimeout` so the declared default is actually achievable end-to-end.

### D2. HIGH — disposing the fiber mid-connect resurrects the bridge and leaks port 9876
**`dsh-plugin/src/bridge.js:155-175` (`start`) and `:325-336` (`dispose`)** · confidence: HIGH (confirmed by reading both paths; reproduced by the subagent with a stub adapter)

`dispose()` closes only the adapter that exists *at dispose time*, and never awaits the in-flight connect:

```js
async function dispose() {
  disposed = true; state = 'disposed'
  const instance = adapter; adapter = null
  if (instance) { await instance.close().catch(() => {}) }   // adapter is still null here
}
```

Meanwhile `start()` has no `disposed` re-check after its awaits and unconditionally adopts the instance:

```js
await withTimeout(instance.connect(), connectTimeoutMs, ...)
adapter = instance; state = 'ready'; extensionConnected = true
```

**Symptom:** a hot reload during the ≤10s window where the bridge is waiting for the extension to dial in → `dispose()` releases nothing, `start()` later adopts the adapter, `state` flips `'disposed'` → `'ready'`, and nothing ever closes it. The old closure is unreachable, so its `WebSocketServer` holds 9876 **for the life of the process**; the next mount's first `gemini_*` call dies with `EADDRINUSE` permanently. `gemini_status` meanwhile reports `ready` while every tool call rejects with "was disposed".

This is notable because the author *did* think about this hazard — [README.md:37-38](dsh-plugin/README.md#L37-L38) documents closing a half-open server "because a driver that timed out still holds the port" (the `instance.close()` in `start()`'s catch), and [README.md:39-40](dsh-plugin/README.md#L39-L40) promises "disposing the plugin fiber releases the port, so a hot reload does not leave the browser orphaned". The error path is handled; the disposal path is not.

**Fix:** in `dispose()`, set `disposed = true`, then `await connecting?.catch(() => {})` and close whatever `start()` adopted. In `start()`, add `if (disposed) { await instance.close(); throw new Error('…disposed') }` immediately after the connect await.

### D3. MEDIUM — the freeze-recovery answer is thrown away, and `recovered` can never be true
**`extension/background.js:730-734` + `src/adapter/gemini-adapter.ts:83-93`** · confidence: HIGH (traced statically across four hops)

The recovery reply omits `turnComplete`:

```js
ws.send(JSON.stringify({ id: turn.id, success: true,
  response: { success: true, recovered: true, text: res.text, chatId: res.chatId } }));
```

but `ask()`'s success test requires it:

```ts
if (res.success && res.data && res.data.success && res.data.turnComplete) { … }
const errMsg = res.error || (res.data && res.data.error) || 'Failed to get Gemini response.';
throw new Error(errMsg);
```

**Symptom:** when the freeze watchdog fires and *succeeds* — reloading the tab and re-reading the saved answer — the adapter discards the recovered text and throws the generic `Failed to get Gemini response.` The model gets no answer and no hint that the tab froze. Separately, `ask()` never copies `recovered` off the result (it returns only `{chatId, text, images, partial}`), so `tools.js:234`'s `recovered: response?.recovered === true` is hard-wired `false` — an output field the schema declares and `SKILL.md:49` documents as an answer-integrity signal.

This compounds Part I #7: that one says recovery will not *finish* in time; this one says that if it does finish, the result is dropped. Both must be fixed for the feature to mean anything.

**Fix:** add `turnComplete: true` to the recovery reply, and `recovered: res.data.recovered === true` to `ask()`'s return.

### D4. MEDIUM — cookie backup is written world-readable to an unignored path
**`dsh-plugin/src/lib/artifacts.js:20`, reached from `tools.js:784`** · confidence: HIGH on the mode, MEDIUM on the git half

`gemini_cookies_backup` writes live Google session cookies with `await fs.writeFile(file, data)` — no `mode`, so the file lands at `0o666 & ~umask`, typically `0644`, i.e. readable by every local user. The tool's own description says "treat the file as a credential". The path is `<projectRoot>/.timepass/transcripts/`, and there is no root `.gitignore` (Part I #2) to exclude it.

**Fix:** `{ mode: 0o600 }` on the write, and add `.timepass/` to the gitignore.

### D5. MEDIUM — a negative `timeoutMs` is accepted and returns an instant empty answer
**`dsh-plugin/src/tools.js:209`** · confidence: HIGH on the guard, MEDIUM on the page behaviour

```js
timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : config.timeoutMs,
```

"is a number" where "is a positive number" was meant — inconsistent with the sibling guards at `tools.js:471` (`maxDepth >= 0`) and `tools.js:662` (`limit > 0`). The schemas (`tools.js:322`, `:353`) declare `type: 'number'` with no `minimum`.

**Symptom:** the page does `payload?.timeoutMs || 60000` ([content.js:979](extension/content.js#L979)); a negative number is truthy, so `deadline = startedAt + (-1)` is already past and `observeResponse` returns immediately with a near-empty `partial: true` answer instead of an argument error. Note this path is live *despite* D1 — the nested `timeoutMs` is ignored by the driver's own budget but still reaches the page.

**Fix:** `args.timeoutMs > 0` in the guard, plus `minimum: 1` in both schemas.

### D6. LOW — a failed artifact write discards the answer
**`dsh-plugin/src/tools.js:226`** · confidence: HIGH
If `writeArtifact` throws (ENOSPC, unwritable dir, bad `saveTo`), the whole tool call fails and the already-retrieved answer is lost — the model gets a bare errno instead of the text. Bookkeeping sits on the success path of the primary result. **Fix:** catch, return the text with `savedTo` omitted and a `saveError` in the footer.

### D7. LOW — `maxDepth` is never forwarded (same root cause as Part I #18)
**`dsh-plugin/src/tools.js:471-473`; the false claim is `lib/tree.js:22-27`** · confidence: HIGH on the miss
`dumpDom(selector)` sends only `{ selector }`, so `serializeSubtree` always uses depth 10 with `getBoundingClientRect()` per node, then `countNodes` walks all of it — while `tree.js` documents the pruning as letting a caller "ask for a shallow outline without paying for the full one". Output is correct; only the stated cost model is false. **Fix:** forward the bound (`content.js:1026` already accepts `maxDepth`).

### D8. LOW — unbounded read of a model-supplied path
**`dsh-plugin/src/tools.js:822-827` → `lib/artifacts.js:35`** · confidence: HIGH on the absence of a bound
`gemini_cookies_restore.file` is read whole and then `JSON.parse`d with no size cap and no streaming. **Fix:** `stat` and reject above a few MB.

### D9. LOW — unreachable branch
**`dsh-plugin/src/tools.js:822-823`** · confidence: HIGH
`requireText` throws on an empty string and `resolveOutputPath` returns null only for a blank/non-string, so the `if (!file) throw` is dead. Cosmetic — delete it.

**Verified clean, so they need not be re-derived:** `bridge.js` reaches the extension correctly through the real `GeminiAdapter`/`ExtensionDriver` on 9876 (`adapter-loader.js` resolves `../../src/index.ts` then `../../dist/index.js`); `dump.tree` is correct despite the double `{success,result}` wrap, because the adapter unwraps it with `res.data.result ?? res.data` ([gemini-adapter.ts:236](src/adapter/gemini-adapter.ts#L236)); `ctx.effect`, `inject: ['tools','commands']`, the `{kind:'success',text}` command result, `defineTool`'s `presentationMeta` → `result.meta` plumbing, and the `additionalProperties:false` output schemas all match the harness contracts.

---

## Session preflight — implemented (Part II)

The preflight check the agent routinely skips is now a tool, and its verdict is recorded on every ask result so it cannot be lost between the check and the reply.

**New tool — `gemini_session`** (`dsh-plugin/src/tools.js`). Inspects the session and, when asked, opens one. Does not ask Gemini anything — it only reports which conversation is open.

| Param | Notes |
|---|---|
| `ensure` | Open a Gemini tab if none is open (default false — never opens a tab unless asked) |
| `wantNew` | Open a new tab, because `newChat` is not wired through to the open tab |

Returns `kind`, `url`, `conversationId`, `tabCount`, `opened`, `ok`, `guidance`.

`kind` is one of `none`, `nonChat`, `new`, `existing`; `ok` is `true` only for `new` and `existing`. `guidance` says plainly what to do next, so the verdict does not depend on the agent remembering the rule.

**Recorded on every ask reply** — `gemini_ask` and `gemini_ask_with_files` now carry `sessionKind`, `sessionUrl`, and `sessionConversationId`, and the rendered footer says which session the answer came from. A reply from `nonChat` is flagged as a warning; `existing` is labelled with the conversation id.

**Pure classifier** — the URL classification lives in `dsh-plugin/src/lib/session.js` (no DOM, no bridge, no I/O), so it is unit-testable. `dsh-plugin/src/lib/session.test.js` pins all four kinds plus the conversation-id extraction.

**Docs** — `SKILL.md` preflight section now walks the four kinds and their actions; the Rules list adds "Check the session before asking"; `references/tools.md` documents `gemini_session` and the three new ask fields; `references/troubleshooting.md` gains "The answer came from the wrong conversation".

**Verified:** `node --check` on all four plugin files; `npx vitest run` → **97/97 passing** (up from 83, +14 new tests). The bridge was down during this work, so the tool's live behaviour against a real extension was not exercised — the classifier and its tests are deterministic, the tool wiring is traced statically.

**Caveats carried over from the review, not fixed here:**
- `wantNew` opens a **new tab** rather than navigating the open one, because `newChat` is not wired through to the existing tab (finding #1). That is a workaround, not a fix — the root cause is still open.
- `ensure` opens a tab pinned and background-only, so the user sees it appear.
- If you are logged out, the opened tab lands on a sign-in page and `gemini_session` reports `nonChat` — nothing in the tool surface can log you in.
- `getOrCreateGeminiTab` always takes `tabs[0]` (finding #15), so with multiple Gemini tabs open the preflight reports the first one and the ask drives the first one.

### Two process notes

- **`npm run lint` only covers `extension/`.** `src/` is never linted, which is why the unused `uploader` binding in [image-uploader.ts:23](src/components/image-uploader.ts#L23) and the unused import in [cdp-driver.ts:2](src/driver/cdp-driver.ts#L2) survive. Extending the config to `src/**/*.{ts,js}` is a cheap win.
- **The `timeoutMs` bug was invisible to a passing test suite**, because the test asserts on a message shape production never sends. The general lesson: when a value crosses a layer boundary, assert on the value *as the consumer receives it* — or the test and the bug will agree with each other indefinitely.
