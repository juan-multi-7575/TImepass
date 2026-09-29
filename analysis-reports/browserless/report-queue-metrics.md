# Deep-Dig: Concurrency / Queue / Metrics System (browserless)

Feature: **Concurrency enforcement, request queueing/timeout, and metrics recording** — how browserless caps concurrent sessions, admits/queues/rejects/times-out jobs, and records CPU/memory/session metrics end-to-end.

Target repo: `@browserless.io/browserless` v2.56.0 (`analysis-repos/browserless`).

---

## One-paragraph summary

browserless enforces its concurrency cap with a single in-process **Limiter** (`src/limiter.ts`), which is a subclass of the tiny npm `queue@7` async queue (autostart, `concurrency = CONCURRENT`, `timeout = TIMEOUT`). Every "concurrency-gated" route (`route.concurrency === true`) gets its handler wrapped by a `limiter.limit(...)` closure (also used for the `router.ts` WS upgrades). On each request the Limiter runs an admission pipeline: (1) optional per-request `bypassLimits` predicate, (2) optional CPU/memory health gate from **Monitoring** (`monitor.overloaded()`, off unless `HEALTH=true`), (3) `hasCapacity` check (`length < concurrency + queued`) → reject with 429 + `metrics.addRejected()` + reject webhook, (4) `willQueue` → `metrics.addQueued()` + queue webhook. Admitted jobs are pushed onto the queue; the billing clock (`job.start`) starts only at *execution*. The queue package fires `success`/`error`/`timeout` events that Limiter maps into **Metrics** (`addSuccessful/addError/addTimedout`, each pushing a recorded `sessionTime`), plus the `hooks.after()` lifecycle hook. For browser WS routes, the handler promise stays pending for the whole socket lifetime, so each WS holds one concurrent slot. Metrics are accumulated in an in-memory `Metrics` singleton, snapshotted every 5 minutes by `Browserless.saveMetrics()`, appended (capped at 10k rows) to a JSONND metrics file (`METRICS_JSON_PATH`, default `/tmp/browserless-metrics.json`), and served/consumed by the management routes (`/metrics`, `/metrics/total`, `/pressure`). Good news for accuracy: `writeResponse` guards on `headersSent`/`isConnected`, so the 429/408 written by the limiter and the server's error handler never double-write.

---

## Architecture / call-chain diagram (text)

```
                     HTTP 'request' / 'upgrade'
                               |
                   HTTPServer (src/server.ts)
                   handleRequestUnsafe -> handleUpgrade
                     hooks.before(); token check (metrics.addUnauthorized on 401)
                               |
                     Router.getRouteForHTTPRequest / getRouteForWebSocketRequest
                     (path: micromatch matchers compiled once)
                               |
        registerHTTP/WebSocketRoute wrapped the handler ONCE at registration:
        route.concurrency ? limiter.limit(wrapped, ...) : wrapWithAfterHook(wrapped)
   (src/router.ts:291-300 HTTP, :336-345 WS)
                               |
               +--------------+---------------+
               |      LIMITER (src/limiter.ts)   extends queue@7
               |      limit() -> admit() pipeline
               |       1. timeout = ?timeout || config.getTimeout()      (:191)
               |       2. bypassLimits?.(...args)                        (:194)
               |       3. if HEALTH: monitor.overloaded() CPU/mem gate    (:207-226)
               |       4. if !hasCapacity: 429 + addRejected + rejectAlert (:228-244)
               |       5. if willQueue:    addQueued + queueAlert        (:246-250)
               |       6. bound job (job.start=billing, addRunning)       (:252-266)
               |       7. this.push(job)                                 (:276)
               +--------------+---------------+                (Metrics/WebHooks/Hooks injected)
                               | queue@7 fires events
         +---------------------+--------+---------------------------+
         | success            error    | timeout
   handleSuccess (:94)    handleFail (:132)    handleJobTimeout (:109)
   addSuccessful(time)   addError(time)        addTimedout(time)
   jobEnd->hooks.after    errorAlertURL         timeoutAlertURL
                                   +-> onHTTPTimeout: writeResponse 408
                                   +-> next() (slot released)
                               |
        route handler runs (wrapped by router.wrap*) :
        BrowserHTTPRoute: getBrowserForRequest -> handler -> complete(browser)
        BrowserWebsocketRoute: getBrowserForRequest -> browser.proxyWebSocket
            (asserted promise resolves on socket close -> complete -> close)
        non-browser: plain handler
                               |
        browserless.ts wrapper carries per-request result into metrics via
        hooks.after -> (metrics success/error/timeout recorded in limiter)
                               |
        Metrics snapshot every 5 min (browserless.ts:519-524):
        saveMetrics -> monitoring.getMachineStats() + metrics.get()
        (cpu/memory from Monitoring, cpu via EMA smoothing over cgroup/host)
        append JSONND to METRICS_JSON_PATH (cap 10_000 rows)
                               |
        Consumers: GET /metrics, GET /metrics/total (billing units),
                   GET /pressure (CPU/memory/availability/reason), WebHooks
```

Data flow for a **browser WS session** (holds a slot for the whole socket):

```
WS upgrade -> router -> limiter.limit -> getBrowserForRequest (launch Chromium,
create BrowserlessSession, NumConnected=1) -> chromium.ws.ts handler ->
browser.proxyWebSocket(req,socket,head)   [promise resolves ONLY on socket close]
-> router.wrapWebSocketHandler finally -> browserManager.complete(browser)
-> --numbConnected; resolve session resolver; close() (keep-open if keepUntil)
```

---

## Key files + line references

**Limiter / queue**
- `src/limiter.ts:29-45` — `Limiter extends q`; `super({ autostart:true, concurrency: config.getConcurrent(), timeout: config.getTimeout() })`; `this.queued = config.getQueued()`.
- `src/limiter.ts:51-64` — live updates via `config.on('concurrent'/'queued'/'timeout')` (dynamic `setConcurrent` etc.).
- `src/limiter.ts:78-84` — overrides base `queue@7._errorHandler` to just log (neutralizes queue's built-in `end()`-on-error behavior).
- `src/limiter.ts:94-107` — `handleSuccess`: `metrics.addSuccessful(Date.now()-job.start)`, `hooks.after({status:'successful'})`.
- `src/limiter.ts:109-130` — `handleJobTimeout`: `metrics.addTimedout`, `webhooks.callTimeoutAlertURL`, `job.onTimeoutFn(job)` (writes 408), `hooks.after({status:'timedout'})`, then `next()` (slot freed).
- `src/limiter.ts:132-152` — `handleFail`: `metrics.addError`, `webhooks.callErrorAlertURL`, `hooks.after({status:'error'})`.
- `src/limiter.ts:160-178` — `executing`, `waiting`, `willQueue`, `concurrencySize`, `hasCapacity` (`length < concurrency+queued`).
- `src/limiter.ts:180-284` — `limit()` admission pipeline (breakdown above). **No comments** apart from the doc graph.
- `src/limiter.ts:268-276` — job built with `{args,onTimeoutFn,start,timeout,route}` then `this.push(job)`.

**Metrics**
- `src/metrics.ts:6-15` — counters: sessionTimes, successful, queued, rejected, unauthorized, concurrent, timedout, running, unhealthy, error.
- `src/metrics.ts:17-59` — `addSuccessful/addTimedout/addError` (decrement running, push sessionTime), `addQueued/addRejected/addUnhealthy/addUnauthorized/addRunning` (running peak → `concurrent`).
- `src/metrics.ts:61-80` — `get()` returns stat snapshot + `calculateStats`.
- `src/metrics.ts:82-93` — `reset()` (per save-period clear).
- `src/metrics.ts:95-109` — `calculateStats`: maxTime/meanTime/minTime/totalTime + `units = Σ ⌈sessionTime/30000⌉` (30s billing increments).
- `src/metrics.spec.ts`, `src/limiter.spec.ts` — unit coverage.

**Monitoring (CPU/memory for health + saveMetrics)**
- `src/monitoring.ts:373-390` — constructor: `detectMachineStatsSource(config.getMachineStatsSource())`, immediate `firstSamplePromise`, then `setInterval(sample, getCpuSampleIntervalMs())` with `.unref()`.
- `src/monitoring.ts:392-408` — `sample()`: reads cpu/memory; CPU EMA: `smoothedCpu = alpha*current + (1-alpha)*smoothedCpu`.
- `src/monitoring.ts:410-412` — `getMachineStats()` (used by `saveMetrics` and `/pressure`).
- `src/monitoring.ts:414-454` — `overloaded()`: **hysteresis** — set overloaded at `cpuInt >= CPU_LIMIT`, clear only below `CPU_LIMIT - hysteresis`; memory overloaded at `memoryInt >= MEMORY_LIMIT`.
- `src/monitoring.ts:320-353` — cgroup v1/v2 vs host detection, parse helpers `parseCpuMax` (:24), `parseCpuStatUsageUsec` (:38).

**Orchestration / persistence**
- `src/browserless.ts:111-127` — constructors: `new Metrics()`, `new WebHooks(config)`, `new Monitoring(config)`, `new Limiter(config,metrics,monitoring,webhooks,hooks)`, `new Router(config,browserManager,limiter)`.
- `src/browserless.ts:233-273` — `saveMetrics()`: `monitoring.getMachineStats()` + `metrics.get()` + CPU/memory merge → `metrics.reset()` → `fileSystem.append(metricsPath, json, false, metricsMaxEntries)`.
- `src/browserless.ts:75,519-524` — save interval `5*60*1000` ms; `setInterval(()=>saveMetrics().catch(...))`.
- `src/browserless.ts:392-412` (HTTP) and `:440-458` (WS) — route instantiation + injection of `route.limiter/metrics/monitoring`.
- `src/config.ts:248-258` — `CONCURRENT` (default 10), `QUEUED`/`QUEUE_LENGTH` (default 10), `TIMEOUT`/`CONNECTION_TIMEOUT` (default 30000 ms; aliases for legacy names).
- `src/config.ts:280-300` — `MAX_CPU_PERCENT`/`MAX_MEMORY_PERCENT` (99), `MACHINE_STATS_SOURCE` (auto), `CPU_SAMPLE_INTERVAL_MS` (1000), `CPU_EMA_ALPHA` (0.3), `CPU_OVERLOAD_HYSTERESIS` (10), `HEALTH` (health checks, default false), alert URLs (QUEUE_ALERT_URL, REJECT_ALERT_URL, TIMEOUT_ALERT_URL, FAILED_HEALTH_URL, ERROR_ALERT_URL).
- `src/config.ts:236-238` — `METRICS_JSON_PATH` default `/tmp/browserless-metrics.json`.
- `src/config.ts:641-659` — `setConcurrent/setQueued/setTimeout` emit events that the limiter subscribes to.

**Router wiring**
- `src/router.ts:102-126` — `getTimeout()` (reads `?timeout=`), `onQueueFullHTTP/WebSocket` (write 429), `onHTTPTimeout/WebsocketTimeout` (write 408).
- `src/router.ts:279-324` — `registerHTTPRoute`: `route.concurrency ? limiter.limit(wrapped, onQueueFullHTTP, onHTTPTimeout, getTimeout, route.bypassLimits, route) : wrapWithAfterHook`.
- `src/router.ts:326-358` — `registerWebSocketRoute`: same wiring for upgrades (`onQueueFullWebSocket`/`onWebsocketTimeout`).
- `src/router.ts:138-178` — `wrapWithAfterHook`/`fireAfterHook` fire `hooks.after()` for `concurrency=false` routes (so metrics still record).
- `src/router.ts:180-277` — `wrapHTTPHandler` (launches browser, `complete()` in finally, `Promise.race` vs `res.close`) and `wrapWebSocketHandler`.

**BrowserManager / session lifecycle (ties concurrency to actual browser sessions)**
- `src/browsers/index.ts:433-533` — `close()`: `keepOpen = (numbConnected>0 || hasKeepUntil) && !force`; sets keep-until timer; evicts browser synchronously.
- `src/browsers/index.ts:563-583` — `complete()`: resolve session resolver, `--numbConnected`, then `close()`. Called (via router finally) when the route handler finishes.
- `src/browsers/index.ts:838-853` — `BrowserlessSession` created with `numbConnected: 1`, `startedOn`, `ttl: 0`, etc.
- `src/browsers/index.ts:871-882` — `browser.once('close')` orphaned-session cleanup.
- `src/shared/chromium.ws.ts:22` — `concurrency = true`; handler → `browser.proxyWebSocket(req,socket,head)`.
- `src/shared/browser.ws.ts:24` — `bypassLimits = () => true` (reconnect route skips all admission gates).
- `src/browsers/browsers.cdp.ts:419-439` — `proxyWebSocket` promise resolves only on socket/browser close (that's what holds the slot).
- `src/browsers/browsers.playwright.ts:287-347` — frame-aware PW proxy with socket-close backstop so a malformed upgrade doesn't hang the slot.

**WebHooks (external alert consumers)**
- `src/webhooks.ts:11-44` — `callURL` (GET, 10s `fetchTimeout`), `callFailedHealthURL`, `callQueueAlertURL`, `callRejectAlertURL`, `callTimeoutAlertURL`.
- `src/webhooks.ts:46-62` — `callErrorAlertURL(message)` appends `?error=` to URL.
- `src/utils.ts:979-1004` — `fetchTimeout` (AbortController).

**Metrics consumers (management routes)**
- `src/routes/management/http/metrics.get.ts:27-35` — returns `[` + rows joined from metrics file + `]`.
- `src/routes/management/http/metrics-total.get.ts:29-79` — sums all rows; `meanTime/length`; `estimatedMonthlyUnits = round(units / (rows / 8640))` (5-min buckets → month).
- `src/routes/management/http/pressure.get.ts:91-116` — reads `monitoring.overloaded()`, `limiter.hasCapacity/waiting/executing`, `metrics.get().rejected`; produces `isAvailable`, `reason` ('full'|'cpu'|'memory'), text vs JSON body.
- `src/routes/management/http/active.get.ts:28-30` — liveness 204.

**Utility guards**
- `src/utils.ts:171-216` — `writeResponse`: `if (!isConnected(writeable)) return;` and `if (!response.headersSent) writeHead/end` → prevents double-write when limiter already wrote 429/408 and the error propagates.

---

## Connections map

**Inbound → this system**
- `HTTPServer.handleRequest`/`handleUpgrade` / `hooks.before` → Router (path, auth; `metrics.addUnauthorized` on 401 at `server.ts:107,115`).
- HTTP and WebSocket route registration injects `route.limiter/metrics/monitoring` (`browserless.ts:405-408, 453-455`).
- `Config` events: `concurrent/queued/timeout/cpuLimit/memoryLimit` drive live limiter/monitor changes.
- `getBrowserForRequest` (BrowserManager) feeds per-session browser launch/teardown into the concurrency lifetime.

**Outbound → rest of system**
- **Metrics** → `browserless.saveMetrics()` JSONND file → `/metrics`, `/metrics/total` (billing units, monthly estimate), `/pressure`. Also drives `logger.info` period snapshots.
- **WebHooks** → external alert URLs on queue-full, reject, timeout, failed-health, error.
- **Monitoring.overloaded()** → admission gate (only when `HEALTH` on), `/pressure`, `saveMetrics` cpu/memory.
- **hooks.after()** → SDK hook consumer of per-request status/session-time (also `wrapWithAfterHook` for `concurrency=false` routes).
- **BrowserManager.complete()/close()** → slide/evict sessions, triggers dir cleanup (debounced 200/400/800 ms backoff), keep-until timers.

**Impact: what happens when the concurrency limit is hit.** `hasCapacity=false` → limiter calls `overCapacityFn` (write **429 "Too many requests"**), `metrics.addRejected()`, `webhooks.callRejectAlertURL()`, and rejects with `TooManyRequests` (message noting CONCURRENT + QUEUED). If a slot frees (`next()` on success/error/timeout) before the cap, queued jobs run in FIFO order. Because `queue@7` starts timers only when a *job starts executing*, queued jobs do NOT count billing time (`job.start` is set at execution). Health-checked CPU overload bypasses queueing entirely and 429s immediately (unless `bypassLimits`), preserving existing browser connections.

---

## Gotchas / quirks

1. **Timed-out jobs are not aborted.** On `timeout`, the limiter writes 408 + records timedout + calls `next()` (slot freed immediately), but the underlying `limitFn` promise keeps executing — nothing forcibly closes Chromium or the socket. The still-running work releases its resources only via its own paths (proxy socket-close, `res.close` race, browser crash). So a timed-out session can keep a *browser instance* alive and its data-dir occupied well after its *slot* is freed — momentarily permitting more concurrent sessions than `CONCURRENT`.
2. **`queue@7`'s built-in error→`end()` is neutralized.** Base package runs `this.end(error)` on any job error (would flush all queued jobs/timers); Limiter's `_errorHandler` override (`limiter.ts:78`) downgrades that to a log, so a single failed job never kills the queue.
3. **`browser.ws.ts` (reconnect route) hard-codes `bypassLimits = () => true`** (`src/shared/browser.ws.ts:24`). Those reconnects skip BOTH the CPU/memory health gate AND the capacity cap, so `/devtools/browser/...` reconnects always admit even at full capacity.
4. **Health/CPU admission is off by default** — `HEALTH` defaults to false, so the `monitor.overloaded()` gate silently does nothing unless explicitly enabled.
5. **WS slot held for entire socket lifetime**, and **session `numbConnected` (per-browser) vs. `concurrency` (global queue) are two independent counters** — a leaked/unclosed WS pins a global slot until the socket closes (ties into the sibling ws-protocol dig's finding).
6. **Queue timeout uses `max(0, TIMEOUT)`** (`limiter.ts:63`) — configuring `TIMEOUT=0` disables the per-job timer entirely (never fires).
7. **Metrics are per-save-period snapshots, not cumulative**: `metrics.reset()` runs after every 5-minute `saveMetrics`. `maxConcurrent` is the peak *within* that period; `/metrics/total` re-aggregates across rows.
8. **`units` billing is 30 s granularity** (`metrics.ts:104-107`) and `/metrics/total` extrapolates `estimatedMonthlyUnits` by ratio of observed 5-min buckets to a 30-day month — wildly inaccurate on freshly-started servers (few buckets).
9. **No double-write on rejection**: `overCapacityFn` writes the 429, then the `TooManyRequests` error propagates to `server.ts:handleErrorRequest`; `writeResponse` skips when `headersSent`/`isConnected` is false (`utils.ts:177,196`) — deliberate guard, not a leak.
10. **`?timeout=` per-request override** (`router.ts:102`) is applied over the global timeout and **also applies to WS jobs** — a per-request `timeout` on a browser WS will kill the slot (408 on the socket) while the proxied browser keeps running (quirk #1).
