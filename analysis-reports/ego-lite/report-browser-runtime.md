# Deep-Dig Report: ego-browser Browser Runtime

## Feature
Browser runtime — how ego-browser launches/attaches to a browser, manages the CDP session, dispatches commands, and runs the lifecycle of a browser task.

## One-Paragraph Summary
`ego-browser` is a CDP automation harness that never talks to Chrome directly; it drives the closed-source ego lite app through `globalThis.ego` bindings (primary method `ego.sendCDPMessage`). The browser runtime (`src/browser-runtime.ts`) owns the entire CDP transport: it serializes commands as JSON messages keyed by a monotonic `id`, correlates responses back to a `pending` map, lazily attaches to a page target and caches that session (2s TTL against `Target.attachToTarget` + `Page.enable`), retries once on session-loss (e.g. `Target not found`), and routes inbound CDP **events** through one `handleMessage` dispatcher into a buffered queue (`events`), a set of waiters/`eventWaiters`, and subscribers (`eventSubscribers`). Higher-level helpers in `driver/` and `src/cdp-eval.ts` call `cdp()`/`evaluate()`/`js()` which funnel through `state.send` → browser-runtime `browserCdp()` → `rawCdp()`, so the session/attach/tab logic is centralized and every module reuses it. Errors from the ego binding (stable `error_code`s) are normalized by `src/ego-errors.ts`, whose `buildEgoError` records "hard stop" conditions (user took control / inactive) into the output sink so a swallowed rejection still surfaces as a clean agent-facing message.

## Architecture / Call Chain (text)
```
agent script (heredoc JS)
  --> runMain() [run.ts:61] reads stdin -> execute() [run.ts:108]
  --> new AsyncFunction(names..., code) run with helperContext() [run.ts:115, helpers.ts]
        helpers (pointer/keyboard/nav/observe/waits/files/downloads/screencast)
          └─ call exports: cdp(method,params,sessionId) [cdp-eval.ts:12]
             └─ state.send() [state.ts:10 defaultSend -> browserCdp]  ── (OR state.cdpOverride test stub)
                 └─ browser-runtime.browserCdp() [browser-runtime.ts:79]
                     ├─ ensureSession() [130] : listTabs -> pick active/preferred tab -> Target.attachToTarget(flatten) -> Page.enable -> cache sessionId (2s TTL)
                     ├─ rawCdp() [38] : id = nextMessageId++; pending.set(id,{resolve,reject}); runtime.sendCDPMessage(payload)
                     │     callback runtime.onCDPMessage = handleMessage [232]
                     │     callback runtime.onSendCDPMessageError = handleSendError [224] (rejects all pending)
                     └─ on SESSION_LOST error: invalidateSession() [146] + retry once with fresh session [98-102]
handleMessage (inbound events) [browser-runtime.ts:232]
  ├─ if has "id"  -> resolve/reject matching pending entry
  ├─ Target.detachedFromTarget/targetDestroyed -> clear page/dialog state, maybe invalidateSession
  ├─ Page.javascriptDialogOpening/Closed -> pendingDialogs map
  ├─ eventSubscribers (e.g. screencast Page.screencastFrame) -> listener(datum)
  ├─ push to buffered events[] [164] (cap 10000, splice head)
  └─ eventWaiters (waitForBrowserEvent [169]; waitForRequest/Response, waits.ts:261) -> resolve
```
The same `handleMessage`/`SET` transport is reused for everything; `instalEgoSdk` [index.ts:144] additionally wraps `ego.createTab` and several task-space methods so they invalidate the CDP session when tabs change.

## Key Files + Line References
- **src/browser-runtime.ts** (the runtime core, 326 lines)
  - Constants: `RESPONSE_TIMEOUT_MS=15000` (L4), `SESSION_TTL_MS=2000` (L5), `MAX_BUFFERED_EVENTS=10000` (L8)
  - `isBrowserRuntime()` (L25) — globalThis.ego + sendCDPMessage probe
  - `browserEgo()` (L31) — get the ego binding (throws if missing)
  - `rawCdp()` (L38) — low-level request; sets callbacks a la send, builds `{id,method,params,sessionId}`, `pending` map, 15s timeout, `runtime.sendCDPMessage`
  - `browserCdp()` (L79) — public; cdpOverride test path; auto-`ensureSession` for non-browser-level methods; single retry with fresh session on `SESSION_LOST`
  - `ensureSession()` (L107) — attach/caching + `enablePageEvents` (Page.enable, L205)
  - `invalidateSession()` (L146) — clears session state (not invoked by error path, only by wrappers & target-destroyed)
  - `setPreferredTarget`/`clearPreferredTarget` (L156/160)
  - `drainBrowserEvents()` (L164) — splices the buffered queue
  - `waitForBrowserEvent()` (L169), `subscribeBrowserEvent()` (L188), `pendingDialog()` (L198)
  - `handleSendError()` (L224) — buildE-**egoError** per failure, rejects every pending
  - `handleMessage()` (L232) — the central dispatcher (async responses + events)
  - `browserSnapshotRefsToRefMap()` (L309) — fills ref-map from snapshot refs
- **src/state.ts** — `state = { send: defaultSend, ... }` (L24); `defaultSend` (L10) re-routes to `browserCdp`; `cdpAvailable()` (L46) drives `--doctor`; `setOverrides()` (L50)
- **src/cdp-eval.ts** — `cdp()` (L12), `evaluate()` (L36, IIFE-wrap for string with `return`, L61), `runtimeValue()` (L96), `decodeUnserializableJsValue()` (L133), `hasReturnStatement()` (L157)
- **src/index.ts** — `installEgoSdk()` (L144); `wrapInvalidating` (L281) invalidates session after task-space changes; `wrapCreateTab` (L303) sets preferred target; CI path `isDirectCli()` (L256) → `runMain()`
- **src/run.ts** — `runMain()` (L61) `--doctor`/`--reload`, `execute()` (L108) AsyncFunction
- **src/ego-errors.ts** — `EGO_ERROR_CODES` (L21), `isEgoUserControlError` (L114), `isEgoHardStopError` (L131), `buildEgoError` (L142, marks `markHardStop`), `assertNoEgoError` (L162)
- **driver/nav.ts** — `goto` (L60), `pageInfo` (L83) uses dialog from runtime, `listTabs` (L112), `switchTab` (L153) → `invalidateSession`+`setPreferredTarget`, `newTab` (L168), `openOrReuseTab` (L182), `closeTab` (L216)
- **driver/observe.ts** — `drainEvents` (L45), `snapshotRaw` (L49) → builds ref-map L61, `snapshot` (L73), `elementCenter` (L82), `screenshot` (L97) uses `pendingDialog` (L115)
- **driver/screencast.ts** — `startScreencast` (L35) `ensureSession`+`subscribeBrowserEvent("Page.screencastFrame")`+`Page.startScreencast`; `stopScreencast` (L129)
- **driver/waits.ts** — `waitForNetworkMatch` (L250) uses `waitForBrowserEvent`; `acquireNetworkEvents` (L449); `waitForSelector` (L491)
- **driver/downloads.ts** — `waitForDownload` (L49) uses `ensureSession` + `waitForBrowserEvent`
- **driver/pointer.ts** — `wheel` (L481) `browserCdp` with 1s timeout; `dispatchMouse` (L579/584) `browserCdp` `Input.dispatchMouseEvent`
- **driver/keyboard.ts** — `dispatchKeyEvent` (L530) `browserCdp` `Input.dispatchKeyEvent`
- **driver/element-ops.ts** — `resolveDelete` (L13) → `resolveElementObjectId`; `releaseHandle` (L30) `Runtime.releaseObject`
- **video-recorder.ts** — `VideoRecorder` (L19), consumed by screencast only
- **output-sink.ts** — `markHardStop()` (L51) called by `buildEgoError`

## Connections Map
Inbound → browser-runtime
- `state.ts` defaultSend → `browserCdp` (only consumer of low-level transport besides screenCast)
- `driver/pointer.ts` `browserCdp` for `Input.dispatchMouseEvent`
- `driver/keyboard.ts`
- `driver/observe.ts` `ensureSession`/`drainBrowserEvents`/`pendingDialog`
- `driver/nav.ts` `ensureSession`/`pendingDialog`/`isBrowserRuntime`/`invalidateSession`/`setPreferredTarget`
- `driver/downloads.ts`, `driver/waits.ts` → `waitForBrowserEvent`
- `driver/screencast.ts` → `ensureSession`+`subscribeBrowserEvent`
- `index.ts` installEgoSDK wrappers (invalidateSession/setPreferredTarget)

Outbound: browser-runtime →
- `state.ts` (owns session cache ids)
- `..http.ts` (browserFetch/serverFetch) — likely uses state.send/installs n/a
- `element-resolver.ts` consumes via `cdp` (Runtime.evaluate at L128) through State
- `ref-state.ts`→`browserRefMap` filled by `browserSnapshotRefsToRefMap` after snapshot
- `output-sink.ts` (hard-stop notification)
- `video_recorder.ts` is screen-stream only (doesn't touch runtime directly)
- Tests (`.test.mjs`) stub `FakeEgo`/`__testing.setOverrides`

## Impact Analysis
- The attach-caching TTL means every worker shares ONE cdp session; switching tabs invalidates it so the next command re-attaches to the right target — correctness depends on `switchTab`/`createTab`/`closeTab` calling `invalidateSession`+`setPreferredTarget`.
- `browserCdp` retry-once-on-session-loss (`SESSION_LOST`) hides transient target misses, but the retry throws the newest error on the second failure — callers must still handle it.
- The 10k event buffer cap prevents unbounded growth in long-lived SDK embedding; heavy `drainEvents` producers (network/waits) depend on this.
- `handleMessage` runs every event through all waiters + all subscribers; a throwing waiter is removed & rejected, so a misbehaving predicate can't hang the loop.
- Dialog tracking (Page.javascriptDialogOpening/Closed) is best-effort (`Page.enable` failures swallowed, L212) — screenshots/observe defer to `pageInfo`/dialog path to avoid capturing a blocked page.
- HardStop: `buildEgoError`→`markHardStop` is a single birthpoint so a swallowed EGO_TASK_SPACE_USER_IN_CONTROL still discards output & halts; the output sink separate from runtime but coupled through ego-errors.

## Gotchas / Quirks
- Two separate CDP paths exist: `browserCdp`+`rawCdp` (rust) and `cdp()` in cdp-eval which goes through `state.send`. They share session id state (`state.sessionId`) but have distinct request-id counters and pending maps. `cdp()` is used by most drivers; `browserCdp()` by pointer/keyboard/screencast/state. Since `cdp()` lacks the session-loss-retry and `browserCdp` has it, some code paths get the auto-retry and some don't.
- `Session TTL 2s`: `ensureSession` re-xmits `Target.attachToTarget` even if still attached when the TTL expires (but skips when `state.sessionId`+target match). This doubles as a freshness check and keep-alive.
- `handleMessage` rejects any pending entry whose numeric `id` isn't found — a delayed/injected event causes a no-op.
- `Page.screencastFrame` is special-cased: it's delivered to subscribers ONLY and NOT double-buffered into `events` (L286), so `drainEvents` never sees frames for recording.
- `assertNoEgoError` only throws on `result.error` field; `browserEgo().snapshot` rejects instead, so observe.ts routes the rejection through `buildEgoError` (snapshotRaw catches & wraps, L53-60).
- Legacy `page.evaluate(string, targetId)` second-arg overload (cdp-eval.ts:41-55) pre-dates the "arg" API; a non-string arg to the string form throws TypeError (L43).
- `readResponseBody` falls back from `Network.getResponseBody` to waiting for `Network.loadingFinished/loadingFailed` then retrying once — legacy Chrome that no longer caches bodies.
- `stopScreencast` captures a fallback `Page.captureScreenshot` if no `Page.screencastFrame` ever arrived, so an empty WebM never goes out.