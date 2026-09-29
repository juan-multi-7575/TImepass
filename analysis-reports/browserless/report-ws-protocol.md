# Feature Deep-Dig: WebSocket / DevTools-Protocol Connection Layer

## Feature

The WebSocket/protocol layer that accepts on-the-wire browser automation connections (Puppeteer/CDP over `ws://.../chrome` and `ws://.../chromium`, DevTools over `/devtools/browser/*` and `/devtools/page/*`, and Playwright over `ws://.../playwright/*`), authenticates them, attaches them to a `BrowserlessSession`, launches or re-uses a browser process, and tears it all down when the socket closes.

## One-Paragraph Summary

Browserless is a thin reverse-proxy in front of browsers. Incoming WebSocket upgrade requests are handled at the lowest level by `HTTPServer` (`server.ts`), which moves the `?token=` off the URL query into `Authorization: Bearer`, shims legacy launch params, resolves a route via `Router`, and lets `Token.isAuthorized()` decide before the socket is ever handed to a browser. If the route is a `BrowserWebsocketRoute`, the `Router` asks `BrowserManager.getBrowserForRequest()` to either **reconnect** to an already-running browser (by `/devtools/browser/*` or `/function/connect/*` id), **attach** to an existing page (`/devtools/page/<id>`), or **launch + register** a brand-new browser session in `BrowserManager.browsers`. That launched browser — `ChromiumCDP` (puppeteer-core + `http-proxy.ws`) or a Playwright subclass (`playwright-core` `launchServer` + a frame-aware `ws` bridge) — then proxies the WebSocket to the browser's local CDP endpoint, forwarding CDP/Playwright JSON-RPC frames in both directions and terminating if blocked URLs appear. The proxy promise resolves on socket/process close, which drives `BrowserManager.complete()` to decrement the session's `numbConnected`; once zero (and past the keep-until grace timer) the session's browser process, user-data-dir, and scratch dir are removed, or forced immediately via `killSessions`.

## Architecture / Call-Chain Diagram (text)

```
Browserless.start()
 └─ HTTPServer.start()                       [src/server.ts:119]
     ├─ http.Server.on('request')  → handleRequest()  -> handleRequestUnsafe [server.ts:122,177,192]
     └─ http.Server.on('upgrade') → handleUpgrade()                          [server.ts:123,145]
            └─ handleWebSocket → handleWebSocketUnsafe                        [server.ts:392,415]
                ├─ moveTokenToHeader(?token → Authorization)   [shim.ts:19] [server.ts:421]
                ├─ convertPathToURL + shimLegacyRequests       [server.ts:427-428]
                ├─ hooks.before                                   [server.ts:426]
                ├─ router.getRouteForWebSocketRequest             [server.ts:434] → router.ts:389
                ├─ route.before                                   [server.ts:441]
                ├─ Token.isAuthorized(req, route)  [server.ts:449] → token.ts:17,39
                ├─ querySchema validation                         [server.ts:456]
                └─ route.handler(req, socket, head, logger, browser)         [server.ts:500]
                     └─ (registered via router.registerWebSocketRoute)        [router.ts:326]
                              └─ wrapWebSocketHandler                        [router.ts:235]
                                  ├─ Limiter.limit (concurrency + queue)      [router.ts:337; limiter.ts:180]
                                  └─ browserManager.getBrowserForRequest       [router.ts:250; browsers/index.ts:585]
                                      ├─ reconnect /devtools/browser/*, /function/connect/* → find by id, ++numbConnected [index.ts:631-653]
                                      ├─ attach /devtools/page/<id>                           [index.ts:657-686]
                                      └─ launch NEW browser session
                                          ├─ new Browser (ChromiumCDP | *Playwright)         [index.ts:798]
                                          ├─ browser.launch(...) + hooks.browser             [index.ts:808-815]
                                          ├─ create BrowserlessSession → browsers.set         [index.ts:838-861]
                                          └─ wire orphan `close` listener                    [index.ts:866-882]
                                                  │
                              └─ handler(req, socket, head, logger, browser)
                                  ├─ CDP:      browser.proxyWebSocket → http-proxy.ws(...target=browserWSEndpoint) [browsers.cdp.ts:419-468]
                                  │           proxyPageWebSocket (page attach / BLESS newPage) [browsers.cdp.ts:360-417]
                                  └─ Playwright: browser.proxyWebSocket → ws.handleUpgrade → frame-inspecting bridge [browsers.playwright.ts:287-572]

Teardown (on socket close):
   ├─ CDP: http-proxy resolve on socket/process 'close'          [browsers.cdp.ts:431-440, 394-397]
   ├─ Playwright: socket/ws 'close'|'error' → finish() → safeClose + detach listeners  [browsers.playwright.ts:335-350,545-568]
   └─ Router finally → browserManager.complete(browser)          [router.ts:269-272]
        └─ --numbConnected; if 0 & no keep-until → browsers.delete + browser.close()
             then removeUserDataDir + removeScratchDir           [index.ts:476-507, 563-583]
   └─ Forced: GET /kill/<id> → killSessions()                   [kill.get.ts:38; index.ts:510-532]
```

## Key Files & Line References

| Concern | File:line |
|---|---|
| HTTP server boot + `upgrade` event hookup | `src/server.ts:42,119-143` |
| Upgrade dispatch (WS vs non-WS) | `src/server.ts:123,145-175` |
| WS handler entry + error containment | `src/server.ts:392-413` |
| WS token auth before route handler | `src/server.ts:445-454` |
| Call WS route handler with browser | `src/server.ts:500-505` |
| Token→Authorization move (`?token=` path) | `src/shim.ts:19-38` |
| Token auth | `src/token.ts:17-39` |
| Header/query token read | `src/utils.ts:247-251` |
| Route match for WS requests | `src/router.ts:389-392` |
| WS handler wrap: browser acquire + `finally complete()` | `src/router.ts:235-276` |
| Limiter concurrency/queue gate for WS job | `src/limiter.ts:180-284` |
| Reconnect vs launch branch | `src/browsers/index.ts:631-685` |
| New session registration + session object | `src/browsers/index.ts:838-853` |
| `complete()` teardown | `src/browsers/index.ts:563-583` |
| `close()` teardown + keep-until timer | `src/browsers/index.ts:433-508` |
| CDP `proxyWebSocket` (http-proxy.ws) | `src/browsers/browsers.cdp.ts:419-468` |
| CDP `proxyPageWebSocket` (page attach/newPage) | `src/browsers/browsers.cdp.ts:360-417` |
| CDP page-close-on-socket-close cleanup | `src/browsers/browsers.cdp.ts:360-397` |
| Playwright WS bridge + frame inspector + block/terminate | `src/browsers/browsers.playwright.ts:287-572` |
| WS path constants | `src/http.ts:98-115` |
| CDP/Playwright route classes | `src/shared/browser.ws.ts`, `chromium.ws.ts`, `page.ws.ts`, `function-connect.ws.ts`, `chromium.playwright.ws.ts` |
| Kill sessions (forced teardown entry) | `src/routes/management/http/kill.get.ts:38`, `browsers/index.ts:510-532` |
| Browser binary validation at start | `src/browserless.ts:202-231,354-461` |
| Blocked-URL termination (CDP events / Playwright frames) | `browsers.cdp.ts:143-184`, `browsers.playwright.ts:422-543` |

### Route catalog (paths from `src/http.ts:98-115`)
- `/devtools/browser/*` → `shared/browser.ws.ts` → CDP `proxyWebSocket` (reconnect)
- `/devtools/page/*` → `shared/page.ws.ts` → CDP `proxyPageWebSocket`
- `/chrome`, `/chromium`, `/edge` (CDP) → `shared/chromium.ws.ts` / `chrome/ws/cdp.ts`
- `/chrome/playwright`, `/chromium/playwright`, `/edge/playwright`, `/firefox/playwright`, `/webkit/playwright` (+ `/playwright/{chrome,chromium,firefox,webkit}`) → Playwright
- `/function/connect/*` → `shared/function-connect.ws.ts` (internal reconnect, `concurrency=false`)

## Connections Map

### Inbound (what drives the WS layer)
- **Automation clients**: Puppeteer / `chrome-remote-interface` / Chrome DevTools open `ws://…:3000/chromium/…`; Playwright opens `ws://…/firefox/playwright` (README.md:114, LEARN_MORE.md:53-68).
- **HTTP metadata routes** fan back in: `/json/version`, `/json/list`, `/json/new`, `/function` return `webSocketDebuggerUrl`, `initialConnectURL`, and `killURL` pointing at these WS endpoints (`src/browsers/index.ts:367-431`, `shared/json-new.http.ts:49`).
- **Management**: `GET /kill/<id>` and `GET /sessions` call into session teardown/reporting (`kill.get.ts:38`; `index.ts:557`).

### Outbound (what the WS layer feeds)
- **Browser processes**: `ChromiumCDP.launch` boots Chrome with `--remote-debugging-port` and connects via puppeteer (`browsers.cdp.ts:276-308`); Playwright uses `launchServer()` (`browsers.playwright.ts:220-225`).
- **http-proxy** forwards DevTools traffic to the local CDP WS endpoint (`browsers.cdp.ts:69,399-415`).
- **ws bridge** fans Playwright JSON-RPC into the Playwright server's raw pipe (`browsers.playwright.ts:352-359,500-543`).
- **Session/tracking storage** in `BrowserManager.browsers` map feeding `/sessions` and `GET /kill`.
- **Hooks/Metrics**: `hooks.browser` / `hooks.page` (per session/page), limiter metrics for success/error/timeout/rejection (`browsers/index.ts:173-175,815`; `limiter.ts:94-152`).

## Impact Analysis

A leaked WebSocket connection cascades:
1. **Session slot stays claimed**: `session.numbConnected` counts live sockets bound to a browser. On socket `close` → `complete()` decrements; the browser shuts down only at 0 and outside any keep-until window. A socket that never fires cleanup keeps `numbConnected > 0`, so the browser process, debug port, and profile stay reserved — `CONCURRENT` slots stay consumed and the limiter returns 429s even when idle.
2. **Page attach leaks renderers**: if `proxyPageWebSocket`'s `once('close')` handler never fires, the created `Page` is never `close()`d; each reconnect cycle leaks a renderer (`browsers.cdp.ts:394-397`).
3. **Session teardown is the cleanup chokepoint**: user-data-dir, scratch dir, and the browser process all release only inside `close()` invoked from `complete()` / `killSessions()` / server shutdown (`src/browsers/index.ts:476-507,887-913`). A leaked WS stalls all of these; orphaned dirs are reclaimed later by the `sweepOrphanedDataDirs` sweep (`index.ts:96-112`).
4. **Auth precedes browser spin-up**: token validation runs at `server.ts:445-454` ahead of `getBrowserForRequest()`, so an unauthorized WS never launches a browser — the primary DoS control.
5. **Limiter and `after()` accounting ride on completion**: timed-out or error WS jobs still fire `hooks.after()` and webhooks (`limiter.ts:124-152`); a socket that neither completes nor closes keeps the job counted as running, skewing queue/usage metrics.

## Gotchas / Quirks

- **Reconnect vs page-attach are different mechanisms**: `/devtools/browser/*` reuses a browser by matching `session.wsEndpoint().includes(id)` (`index.ts:642-649`); `/devtools/page/*` (`index.ts:657-686`) queries all live browsers' `http://127.0.0.1:<port>/json/list`, matches `b.id == pageId`, but returns the **browser** — the proxy then targets that browser's endpoint, and the client re-drives the specific page over it.
- **`?token=` is migrated to a header before routing** (`shim.ts:19-38`; called at `server.ts:421`): `Token.isAuthorized` reads `getTokenFromRequest` (authorization header first, then query param — `utils.ts:247-251`). Only requests passing through `server.ts` get the shim, so a custom protocol bypassing it skips token normalization.
- **Reconnect has no per-session ownership check**: `index.ts:642-649` locates by id and increments `numbConnected` with no confirmation that the caller owns the session — knowing/guessing an id grants reconnect to a live browser. Only route-level `auth=true` gates it.
- **Playwright bridge hard-tears down on blocked frames**: a message whose URL matches block config closes *both* sockets with code 1008/1009 and destroys the client socket, so a user navigating a blocked URL is severed, not degraded (`browsers.playwright.ts:501-543`).
- **Promise lifecycle is what triggers `complete()`**: `proxySocket` returns a promise that resolves only on socket/browser/process `close`; `complete()` runs in the wrapped handler's `finally` (`router.ts:269-272`). If proxying rejects, `finally` still fires `complete()`, but a dead browser lingers until its orphan `'close'`/`'disconnected'` listener removes it (`browsers/index.ts:864-882`, `browsers/cdp.ts:314-329`).
- **`/function/connect` skips the limiter**: `concurrency=false` (`src/shared/function-connect.ws.ts:22`), yet the browser still launches through `getBrowserForRequest`, so that path still claims a session.
- **`origin` header is stripped before proxying** by both implementations (CDP `browsers.cdp.ts:448-449`; Playwright `browsers.playwright.ts:307`), so the browser never sees the real CORS/origin header from the client.

## CONNECTIONS SUMMARY
- The WS layer is the single funnel for Puppeteer/Playwright/DevTools (connect), page, and function-connect traffic.
- It connects router → limiter → token → browser manager → per-browser CDP/Playwright proxies → hooks/metrics.
- Session teardown is *entirely* event-driven by socket close (`complete()`), which makes WS lifecycle correctness the core invariant keeping sessions sane, directories reclaimed, and limits enforced.