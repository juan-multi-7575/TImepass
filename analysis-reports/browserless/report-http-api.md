# Feature: HTTP API Request Routing Pipeline

**Repo:** `analysis-repos/browserless` (browserless.io platform, v2.56.0)
**Dig agent:** agent-http-api
**Scope:** How an inbound HTTP request (`/chrome/function`, `/pressure`, `/content`, any other route) flows through the server — route discovery/registration, protocol selection, token auth, body/query schema validation, limiter/queue admission, browser acquisition, execution, and response. WebSocket upgrade handling is covered only where it joins the same pipeline (auth/router/limiter); the full WS/devtools layer is covered by `agent-ws-protocol` (`report-ws-protocol.md`).

---

## One-paragraph summary

Browserless is a Node HTTP server whose entire request path funnels through three cooperating singletons owned by the `Browserless` class: `HTTPServer` (`src/server.ts`) receives every request on node's `request` event, `Router` (`src/router.ts`) picks a route by matching glob-style path patterns against the parsed URL plus method/Accept/Content-Type negotiation, and `Limiter` (`src/limiter.ts`, a subclass of the `queue` npm package) gates execution behind concurrency + queue capacity plus optional CPU/memory health checks. Before a route runs, the server shims the legacy request (`moveTokenToHeader`), fires the global `before` hook, optionally rewrites GET→POST when `ALLOW_GET` + `?body=`, parses and validates the JSON body and query params against per-route JSON schemas, and checks the auth token via `Token`. Browser-backed routes then acquire a live browser from `BrowserManager.getBrowserForRequest` (which handles reconnects, `trackingId`, launch-option parsing, and browser launch), the handler executes, and cleanup/accounting happens through `BrowserManager.complete` plus metric counters and the `after` hook — all wrapped so that timeouts, queue-full rejections, disconnects, and errors map to precise HTTP codes (`429`, `408`, `500`, `401`, `400`).

---

## Architecture / call-chain diagram

```
 Client
   │  HTTP (e.g. POST /chrome/function?token=...&launch=...)
   ▼
 [src/index.ts / src/exports.ts] ── instantiates ──► Browserless (src/browserless.ts)
                                                       start()  (browserless.ts:341)
                                                          │── getRouteFiles(config) ──► scans $ROUTES/{browser}/http|ws
                                                          │── dynamic import(routePath?cb=Date.now())  [browserless.ts:391]
                                                          │── new Route(...) + inject config/limiter/metrics/monitoring/fs
                                                          │── router.registerHTTPRoute(route) / registerWebSocketRoute(route)
                                                          │      └─ wrapHTTPHandler / wrapWebSocketHandler (router.ts:180,235)
                                                          │          then limiter.limit(...) or wrapWithAfterHook(...)
                                                          │── new HTTPServer(config, metrics, token, router, hooks, Logger)
                                                          └── server.start()  (server.ts:119)
   ▲                                                             ├─ server.on('request', handleRequest)   [server.ts:122]
   │                                                             └─ server.on('upgrade', handleUpgrade)   [server.ts:123]
   │
   ▼ handleRequest → handleRequestUnsafe (server.ts:177,192)
   1  moveTokenToHeader(req)                      [server.ts:194, shim.ts:19]
   2  hooks.before({req,res})                     [server.ts:199, hooks.ts:22]
   3  convertPathToURL(url, config) ──► req.parsed [server.ts:200, utils.ts:740]
   4  shimLegacyRequests(req.parsed)              [server.ts:201, shim.ts:48]
   5  CORS (if ALLOW_CORS)                        [server.ts:205-226]
   6  HEAD→GET, GET+?body= →POST (if ALLOW_GET)    [server.ts:228-242]
   7  router.getRouteForHTTPRequest(req)           [server.ts:244, router.ts:366]
        │  match = pathMatchers(glob) + method + Accept∩contentTypes + Content-Type∩accepts
        │  (or static handler fallback for any GET, router.ts:360,385)
   8  route.before(req,res)                       [server.ts:260]
   9  token.isAuthorized(req, route)  (if route.auth)   [server.ts:264-271, token.ts:17]
  10  readBody(req, MAX_PAYLOAD_SIZE)             [server.ts:275, utils.ts:417]
  11  JSON parse + queryParamsToObject            [server.ts:280-281, utils.ts:618]
  12  querySchema → ajv validate                  [server.ts:294-336, compileSchema]
  13  bodySchema → ajv validate                   [server.ts:338-382]
  14  (wrapped) route.handler → limiter.limit()    [router.ts:291-300]
          │  admit(): timeout override → health check → hasCapacity → queue
          │     (limiter.ts:180-283); on rejection → onQueueFull→429 / TooManyRequests
          │  execution: wrapHTTPHandler (router.ts:180)
          │      ├─ BrowserHTTPRoute? BrowserManager.getBrowserForRequest  (browsers/index.ts:585)
          │      │      reconnects (/devtools/browser/, /devtools/page) [index.ts:633-686]
          │      │      launch opts merge, trackingId dedupe, launch, session map [index.ts:689-861]
          │      ├─ Promise.race(handler vs res 'close' event) [router.ts:213-224]
          │      │       handler(req,res,logger[,browser]) e.g. shared/function.http.ts:59
          │      └─ finally: browserManager.complete(browser) [router.ts:227, index.ts:563]
  15  response: writeResponse / jsonResponse / streamed binary, or
      handleErrorRequest maps thrown errors → 400/401/403/404/408/429/500 (server.ts:65-101)
  16  accounting: metrics.addRunning/Queued/Rejected/Successful/Timedout/Error/Unauthorized
      (limiter.ts:99,118,140,199,219,234,249,256; metrics.ts:17-59)
      after-hooks: hooks.after via Limiter.jobEnd (limiter.ts:90) or wrapWithAfterHook (router.ts:138)
      webhooks to QUEUE_ALERT_URL/REJECT_ALERT_URL/FAILED_HEALTH_URL/TIMEOUT_ALERT_URL/ERROR_ALERT_URL
      (webhooks.ts:26-63, fired in limiter.ts)
```

---

## Key files and line references

### Entry / orchestration
- `src/browserless.ts` — `Browserless` class; constructor DI (`:82-138`), `start()` (`:341`):
  - route-file discovery via `getRouteFiles(this.config)` (`:354` → `utils.ts:464`)
  - per-route JSON schema load (`body.query.json`) (`:375-383`), dynamic `import` with cache-buster (`:391`)
  - optional arm64 route filtering (`:142-161`), missing-browser validation & duplicate-name warnings (`:473-495`)
  - `router.registerHTTPRoute`/`registerWebSocketRoute` (`:499-500`)
  - `HTTPServer` construction wiring config/metrics/token/router/hooks (`:506-513`)
- `src/http.ts` — route path registry + protocol metadata:
  - `HTTPRoutes` enum with glob paths (`:117-150`), `HTTPManagementRoutes` (`:152-162`), `WebsocketRoutes` (`:98-115`)
  - `contentTypes` (`:75-85`), `Methods` (`:91-96`), `codes`/`errorCodes` HTTP mapping (`:14-73`)
  - `Request` interface shape (`:170-174`), documented `SystemQueryParameters` (`:178-219`)

### Server (receive → validate → dispatch)
- `src/server.ts` — `HTTPServer`:
  - listeners on `request`/`upgrade` (`:122-123`)
  - `handleRequest` catch-all → error mapping (`:177-190`), `handleRequestUnsafe` (`:192-390`) — the full HTTP pipeline above
  - `handleUpgrade`/`handleWebSocket` for WS (`:145-175`, `:392-512`), non-WS upgrade handling (`:150-175`)
  - `handleErrorRequest` maps typed errors → HTTP status (`:65-101`); `onHTTPUnauthorized` 401 + metric (`:103-109`)
  - `shutdown()` (`:514-525`)

### Router (matching + handler wrapping)
- `src/router.ts` — `Router`:
  - glob-matching with precompiled micromatch matchers (WeakMap) (`:44-49`, `:74-100`)
  - `getRouteForHTTPRequest` — method/accepts/content-type negotiation + static fallback (`:366-387`)
  - `getRouteForWebSocketRequest` (`:389-393`)
  - `registerHTTPRoute`/`registerWebSocketRoute` — binding, wrapping, invariant "exactly one of limiter/wrapWithAfterHook" (`:279-358`), duplicate-path warnings (`:313-320`)
  - `wrapHTTPHandler` — browser acquisition + `Promise.race` vs socket-close + `browserManager.complete` (`:180-233`); `wrapWebSocketHandler` (`:235-277`)
  - `wrapWithAfterHook` + `fireAfterHook` + `ROUTE_DID_NOT_RUN` sentinel (`:26-29`, `:138-178`)
  - queue-full (429) / timeout (408) responders (`:108-126`)

### Limiter (admission control)
- `src/limiter.ts` — `Limiter extends q` (`queue` npm pkg):
  - concurrency/timeout from Config, live-config listeners on `concurrent`/`queued`/`timeout` events (`:40-64`)
  - `limit()` — the admission gate: per-request timeout override (`:191`), optional `bypassLimits` predicate (`:194-201`), health checks via `monitoring.overloaded()` (`:207-225`), capacity check → 429 (`:228-243`), queueing with `QUEUE_ALERT_URL` + `addQueued()` (`:246-250`), job start → `addRunning()` (`:252-257`)
  - `queue` pkg events: `timeout` → `handleJobTimeout` (`:109-130`), `success` → `handleSuccess` (`:94-107`), `error` → `handleFail` (`:132-152`), `end` (`:86-88`)
  - each terminal handler pushes metrics and fires `hooks.after` via `jobEnd` (`:90-92`)

### Auth
- `src/token.ts` — `Token.isAuthorized` (`:17-39`): no token configured ⇒ allow; `route.auth !== true` ⇒ allow; else compare request token (query `?token=` or `Authorization` header) against configured token(s)

### Config (env knobs)
- `src/config.ts` — `Config`:
  - `PORT` (`:222`), HOST (`:218`), `TOKEN` (`:247`), `CONCURRENT` (`:248-252`), `QUEUED` (`:253`), `TIMEOUT` (`:254-258`), `MAX_PAYLOAD_SIZE` (`:294`), `ALLOW_GET`/`ENABLE_API_GET` (`:263`), `CORS*` (`:264-279`), `HEALTH` (`:295`), alert URLs (`:296-300`), `ROUTES` (`:243-245`), `EXTERNAL`/`PROXY_URL` (`:220`), `STATIC` (`:259`), legacy/deprecated var warnings (`:23-89`)
  - getters consumed by pipeline: `getConcurrent` (`:367`), `getQueued` (`:376`), `getTimeout` (`:379`), `getToken` (`:323`), `getMaxPayloadSize` (`:452`), `getHealthChecksEnabled` (`:455`), `getAllowCORS` (`:489`), `getAllowGetCalls` (`:482`), `getCORSHeaders` (`:878`), `getExternalAddress`/`getServerAddress` (`:782`/`:764`)

### Utils / shims
- `src/utils.ts` — `writeResponse` (`:171`), `jsonResponse` (`:218`), `readBody` (`:417`), `readRequestBody` (`:254`), `getTokenFromRequest` (`:247`), `queryParamsToObject` (`:618`), `convertPathToURL` (`:740`), `makeExternalURL` (`:748`), `getRouteFiles` (`:464`), `getAuthHeaderToken` (near `:247`), error classes `BadRequest`/`TooManyRequests`/`Unauthorized`/`NotFound` etc. (`:758+`)
- `src/shim.ts` — `moveTokenToHeader` moves `?token=` into `Authorization: Bearer` header (`:19-38`); `shimLegacyRequests` rewrites legacy launch params (`headless`, `stealth`, `slowMo`, `ignoreHTTPSErrors`, `--switches`, etc.) into `?launch=` JSON (`:48-139`)

### Concrete routes (used in this dig)
- `src/routes/chrome/http/function.post.ts` — thin subclass → `src/shared/function.http.ts`; `path = [HTTPRoutes.chromeFunction]` i.e. `/chrome/function?(/)`; `browser = ChromeCDP`
- `src/shared/function.http.ts` — `ChromiumFunctionPostRoute`, the `/chrome/function` handler: `path` incl. `/function?(/)` (`:57`), handler farms out to `functionHandler` and streams/returns result by detected MIME or JSON/text (`:59-95`)
- `src/shared/utils/function/handler.ts` — in-page function execution: serves function code via request-interception, connects page to browser via `/function/connect/<id>` WS with token (`:88`), runs `BrowserlessFunctionRunner` in page (`:165-195`)
- `src/shared/content.http.ts` — `/content` + `/chrome/content` handler: parses BodySchema, nav-allowed assert, page setup, goto/setContent, `waitFor*`, returns HTML (`:72-277`)
- `src/routes/management/http/pressure.get.ts` — `/pressure` `HTTPRoute` with `concurrency = false` (`:80`); reports `monitoring.overloaded()`, `limiter.hasCapacity/waiting/executing`, `metrics.get().rejected`, config limits (`:91-150`), `text/plain` → 200/503, else JSON 200

### Browser acquisition (the outbound consumer)
- `src/browsers/index.ts` — `BrowserManager.getBrowserForRequest` (`:585-885`): `trackingId` validation (`:600-624`), reconnection paths for `/devtools/browser|page` (`:631-686`), launch-option parse/merge incl. `timeout`, `--proxy-server`, `--user-data-dir` handling (`:688-736`), per-session `TMPDIR` scratch dir (`:738-765`), launch + `hooks.browser` (`:808-815`), session bookkeeping in `this.browsers` Map (`:838-861`), orphaned-process cleanup (`:871-882`)
- `src/browsers/index.ts` — `complete` (`:563-583`): decrements `numbConnected`, resolves the session resolver, triggers `close`/cleanup
- `src/shared/function-connect.ws.ts` — the `/function/connect/*` WS route that pairs function pages to a session; `concurrency = false`, `bypassLimits` path, `browser.proxyWebSocket` (`:29-37`)

### Monitoring / metrics / hooks / webhooks
- `src/monitoring.ts` — `overloaded()` (`:414`) with cgroup/host sources; cpu/memory limits from config
- `src/metrics.ts` — counters `addRunning/Queued/Rejected/Successful/Timedout/Error/Unauthorized` (`:17-59`), `get()` aggregates (`:61-80`), `reset()` (`:82`)
- `src/hooks.ts` — `before`/`after`/`page`/`browser` delegating to `external/*.js` overrides (`:21-36`)
- `src/webhooks.ts` — alert-URL firing (`:26-63`)
- `src/shared/utils/schema-validator.ts` — `compileSchema` used by server.ts `:32` for body/query ajv validation

---

## Connections map

### Inbound (what feeds the pipeline)
- **Client HTTP requests** → node `request` event → `HTTPServer.handleRequest` (`server.ts:122`)
- **Client WS/h2c upgrades** → `upgrade` event → `handleUpgrade` (`server.ts:123,145`)
- **Routes** — registered via `Router.registerHTTPRoute/registerWebSocketRoute` (`router.ts:279,326`), populated by `Browserless.start()` from `getRouteFiles` scan + SDK `addHTTPRoute`/`addWebSocketRoute` (`browserless.ts:307-313`)
- **Config env vars / runtime setters** — Config emits events consumed live by Limiter (`concurrent`,`queued`,`timeout`, `limiter.ts:51-64`)
- **SDK extension points** — subclassable `Config`, `Hooks`, `Limiter`, `Router`, `HTTPServer`, `Token`, `Metrics` (all constructors take instances; module-extension pattern per CLAUDE.md), `external/*.js` legacy hooks (`hooks.ts:13-19`)

### Outbound (what the pipeline affects / calls)
- **`BrowserManager`** — acquires/launches browsers (`getBrowserForRequest`), releases sessions (`complete`); the HTTP path is the primary creator of sessions that `/sessions`, `/kill/*`, `/active` observe and that WS reconnect routes reuse
- **`Metrics`** — every state transition increments a counter; `/metrics`, `/metrics/total`, `/pressure` (`recentlyRejected`), and the periodic `saveMetrics()` persist these (`browserless.ts:233-293`)
- **`Monitoring`** — `overloaded()` gates limiter admission and drives `/pressure` availability + `addUnhealthy`
- **`WebHooks`** — alert URLs fired on queue/reject/failed-health/timeout/error (config-backed)
- **`Hooks`** — `before()` runs before auth/parsing every HTTP & WS request; `after()` runs once per limiter-tracked job and once per `concurrency=false` route; `browser()`/`page()` fire on launch/page-creation
- **Browser/CDP processes** — for `BrowserHTTPRoute` handlers; a change on the HTTP side (e.g., a route's `browser` class, launch opts, timeouts) changes browser lifecycle directly
- **`queue` (npm) library** — Limiter is built on it; `concurrency`/`timeout` semantics come from it
- **Static/legacy endpoints** — unmatched GETs fall back to `/` static route (`router.ts:360,385`); legacy JSON endpoint files under `/json/*`
- **OpenAPI/docs** — route exports (`BodySchema`/`QuerySchema`/`ResponseSchema`) generate `/docs`; schema files loaded at startup (`browserless.ts:375-383`)

### Downstream/impact surface
- `/sessions`, `/kill/*`, `/active`, `/pressure`, `/metrics*` all read state that the HTTP pipeline mutates.
- Client SDKs (`@browserless.io/browserless` exports, puppeteer/playwright connect flows) depend on the specific path globs, `?token=`, `?launch=`, and the GET-body shim.

---

## Impact analysis (does what, and what breaks)

- **Route registration changes** (new path, changed `method`/`accepts`/`contentTypes`) immediately affect matching in `getRouteForHTTPRequest`; duplicate-path warnings are logged but not fatal (`router.ts:313-320`). Removing/`disableRoutes()` a route causes previously-working endpoints to 404 — static fallback for GET can then mask it.
- **Limiter `concurrency`/`queued`/`timeout` are live-tunable** and feed the whole system — reducing `CONCURRENT` while requests are in flight starts 429ing immediately (`limiter.ts:228-243`); saturating memory/CPU flips `/pressure` to 503 and rejects new jobs.
- **`CONCURRENT` > browser capacity**: the limiter is per-instance, not per-browser; a mis-config can launch many browsers past host limits while still admitting to the queue. There is no host-level backpressure beyond the health check (opt-in `HEALTH`).
- **Auth tightening** (`route.auth=true` + `TOKEN` set) affects every browser route and `ForceHTTP` consumers; the token moves from query to header before routing so `Authorization` and `?token=` are equivalent (`shim.ts:19-38`, `token.ts:32-38`).
- **A route's `concurrency=false` bypasses the limiter entirely** — changes there only affect `wrapWithAfterHook`; such routes (e.g. `/pressure`) never 429 and don't consume queue slots, but they also don't get `after()` from limiter events (handled via the wrapper).
- **Browser acquisition failures** bubble as 500/`ServerError` from `wrapHTTPHandler`; a changed `browser` class or launch path breaks every handler relying on it.
- **Schema changes**: body/query schemas are compile-time-validated per request (`server.ts:294-382`); breaking schema changes turn valid client calls into 400s.
- **`ALLOW_GET`** rewrites GET+`?body=` into POST (`server.ts:233-242`); disabling it silently 404s GET callers.
- **`MAX_PAYLOAD_SIZE`** caps body reads; raising it loads more memory, lowering it 400s large JSON payloads.
- **Shutdown**: `stop()` tears down server/browserManager/limiter/router/token/etc. (`browserless.ts:324-339`); in-flight limiter jobs are honored by `queue`, but the HTTP server's close waits for active sockets.

---

## Gotchas / quirks found

1. **The token shim happens *before* routing**, so `req.url` is mutated by `moveTokenToHeader` before `convertPathToURL` parses it (`server.ts:194-200`). Auth accepts `?token=` OR `Authorization: Bearer`; `getTokenFromRequest` prefers the query param over the header (`utils.ts:247-251`).
2. **GET requests can be silently rewritten to POST** (`ALLOW_GET`), and HEAD→GET rewrite drops the HEAD method entirely (`server.ts:228-242`) — affects any route/behavior relying on the raw `req.method`.
3. **Timeout applies at admission AND execution**: the queue-level `timeout` fires `onHTTPTimeout` → 408, but jobs also report metrics on timeout; billing clock starts at execution, not queue admission (`limiter.ts:252-266`).
4. **`willQueue` vs `hasCapacity`**: `queued` counts *queued slots*, `concurrency` active sessions; `hasCapacity = length < concurrency + queued` (`limiter.ts:168-178`). With `QUEUED=0`, any request above `CONCURRENT` is instantly rejected.
5. **`/pressure` reports `recentlyRejected` from `metrics.get().rejected`**, which is the cumulative counter since last `metrics.reset()` (called on save) — not a true "recent" window (`pressure.get.ts:108`, `browserless.ts:243`).
6. **CDP `launch` options and cdp-arg interplay**: `--user-data-dir` args are stripped from args and re-injected as a separate field (`browsers/index.ts:719-736`); `ignoreHTTPSErrors` is renamed to `acceptInsecureCerts` and back-compat both directions (`shim.ts:101-113`, `browsers/index.ts:774-781`).
7. **Browser queries are keyed on the *glob path*, not on method** for reconnect matching: `reconnectionPatterns.some(p => pathname.includes(p))` (`browsers/index.ts:633`), so a leaked WS or orphaned browser pins a `CONCURRENT` slot until closed/complete.
8. **`bypassLimits` is a per-route escape hatch** evaluated on every admit — if it throws, the request is counted as rejected and rejected (429) rather than admitted (`limiter.ts:194-201`).
9. **Non-JSON content is returned as-is** — `writeResponse` only wraps errors as `{error: msg}` for JSON content-types (`utils.ts:181-192`); JSON-error responses differ from text/HTML error bodies, which matters for client parsers.
10. **Route files are dynamically imported with a `?cb=` cache-buster** on every startup (dev-friendly hot reload but a startup cost), and arm64 non-macOS filters drop Chrome/Edge routes silently with a warning (`browserless.ts:142-161`).
11. **Duplicate route names are warnings, not errors** (`browserless.ts:489-495`), and duplicate paths are warnings (`router.ts:313-320`); first-registered wins in `.find()` matching.