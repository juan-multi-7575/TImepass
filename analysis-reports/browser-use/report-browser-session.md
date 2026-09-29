# Browser-Use Deep-Dig: Browser/Session Layer

## Feature name

**Browser/Session layer** — browser launch & lifecycle (`BrowserSession`/`BrowserProfile` under `browser_use/browser/`), CDP connection handling, context/page lifecycle, proxy/stealth config, and tab/`agent_focus` switching during agent execution.

## Summary

`BrowserSession` (`browser_use/browser/session.py`) is a Pydantic model that owns a `BrowserProfile` (pure config template, `profile.py`) and speaks CDP directly to Chromium via `cdp_use.CDPClient` (wrapped by `TimeoutWrappedCDPClient`, `_cdp_timeout.py`). Everything runs on a bubus `EventBus`: the session registers `on_*` handlers for navigation/tab/focus/stop events, and a family of "watchdogs" (each a `BaseWatchdog`) handle launch, DOM, screenshots, downloads, storage-state, security, popups, permissions, recording, and captcha. On `start()` the session either provisions a Browser-Use cloud browser, launches a local Chromium subprocess through `LocalBrowserWatchdog` on a free debug port, or just uses a supplied CDP URL; then `connect()` opens the WebSocket, boots a `SessionManager` that keeps the single source of truth for targets/sessions (fed by `Target.attachedToTarget`/`detachedFromTarget`/`targetInfoChanged`/`Page.lifecycleEvent` events), and sets `agent_focus_target_id` on the first tab. During agent execution the Agent loop calls `get_browser_state_summary()`, and the session routes click/type/navigate/switch-tab work to the *focused* target via `get_or_create_cdp_session()`; when a focused tab detaches or the WebSocket drops, the session auto-recovers focus (`SessionManager._recover_agent_focus`) or auto-reconnects the WS (exponential backoff) respectively. `Browser` is exported as an alias of `BrowserSession`.

## Architecture / Call Chain (text diagram)

```
Agent loop (agent/service.py: run -> _select_next_action -> multi_act -> Tools.act -> Registry)
        │  await browser_session.start()           (service.py:2566 / 3141)
        │  browser_state_summary = await browser_session.get_browser_state_summary()   (service.py:1090)
        ▼
BrowserSession (browser/session.py:134)  ── holds ──► BrowserProfile (browser/profile.py:574)
   │  event_bus = ResilientEventBus (session.py:106/549)
   │
   │ start() (session.py:721) ─► on_BrowserStartEvent (session.py:778)
   │     ├─ if cloud: CloudBrowserClient.create_browser(cloud_params) (cloud/cloud.py:27) → profile.cdp_url
   │     └─ elif is_local: dispatch(BrowserLaunchEvent) ─► LocalBrowserWatchdog.on_BrowserLaunchEvent
   │           (watchdogs/local_browser_watchdog.py:49)
   │              └─ _launch_browser() (line 93): profile.get_args() (profile.py:895) + --remote-debugging-port
   │                   → asyncio.create_subprocess_exec(browser_path, *args) (line 146)
   │                   → _wait_for_cdp_url(port) (line 408) → returns BrowserLaunchResult(cdp_url)
   │
   │ connect(cdp_url) (session.py:1831)  [wrapped in asyncio.wait_for(..., 15s) at session.py:831]
   │     ├─ if http URL: fetch /json/version → webSocketDebuggerUrl (session.py:1852-1878)
   │     ├─ _cdp_client_root = TimeoutWrappedCDPClient(url, headers, max_ws_frame_size=200MB) (1892)
   │     ├─ SessionManager(self).start_monitoring() (session.py:1906-1909 / session_manager.py:63)
   │     │     ├─ Target.setDiscoverTargets (session_manager.py:77)
   │     │     ├─ register attachedToTarget/detachedFromTarget/targetInfoChanged/Page.lifecycleEvent (129-132)
   │     │     └─ _initialize_existing_targets() (784) → attachToTarget per target
   │     ├─ Target.setAutoAttach(autoAttach, flatten) (1914)
   │     ├─ redirect chrome://newtab → about:blank (1926-1943); create blank page if none (1947)
   │     ├─ get_or_create_cdp_session(first_target, focus=True) → sets agent_focus_target_id (1957)
   │     ├─ _setup_proxy_auth() (2020)  [Fetch.enable handleAuthRequests → continueWithAuth]
   │     └─ _attach_ws_drop_callback() (2297)  → on handler-task death → _auto_reconnect() (2239)
   │
   │ dispatch(BrowserConnectedEvent) (860) → StorageStateWatchdog restores cookies/storage
   │
   ▼
CDP session per target (get_or_create_cdp_session, session.py:1472) ─
   ─ sleep via SessionManager pools (_sessions/_target_sessions)
   ─  sends commands on cdp_client.send.<Domain>.method(session_id=session_id)
```

```
| EventBus dispatch | Handler on BrowserSession | CDP call |
|---|---|---|
| NavigateToUrlEvent | on_NavigateToUrlEvent (897) | Page.navigate + lifecycle poll |
| SwitchTabEvent | on_SwitchTabEvent (1131) | Target.setAutoAttach / Target.activateTarget |
| TabCreatedEvent | on_TabCreatedEvent (1190) | Target.createTarget + viewport |
| TabClosedEvent / CloseTabEvent | on_TabClosedEvent (1212) / on_CloseTabEvent (1175) | Target.closeTarget |
| AgentFocusChangedEvent | on_AgentFocusChangedEvent (1224) | focus + clear caches |
| BrowserStopEvent | on_BrowserStopEvent (1279) | cloud stop/ reset / BrowserStoppedEvent → BrowserKillEvent |

## Key files + line refs

* `browser_use/browser/session.py` — BrowserSession (134), init overloads (163-339), reset (628), start (721), kill (728), stop (748), from_system_chrome (439), on_BrowserStartEvent (778), on_NavigateToUrlEvent (897), _navigate_and_wait (1008), on_SwitchTabEvent (1131), on_BrowserStopEvent (1279), cdp_client prop (1331), new_page (1336), get_or_create_cdp_session (1472), get_browser_state_summary (1587), attach_all_watchdogs (1680), connect (1831), _setup_proxy_auth (2020), reconnect (2151), _auto_reconnect (2239), get_tabs (2328), export_storage_state (1427)
* `browser_use/browser/profile.py` — BrowserProfile (574), BrowserConnectArgs (381), BrowserLaunchArgs (395), BrowserNewContextArgs (500), BrowserLaunchPersistentContextArgs (534), ProxySettings (557), CHROME_DEFAULT_ARGS (154)/HEADLESS (116)/DOCKER (120)/DISABLE_SECURITY (133)/DETERMINISTIC (143), get_args (895), _copy_profile (838), _get_extension_args (975) + extension download/extract/patch (1010-1233)
* `browser_use/browser/session_manager.py` — SessionManager (19), start_monitoring (63), _handle_target_attached (402), _handle_target_info_changed (510), _handle_target_detached (530), _recover_agent_focus (636), _initialize_existing_targets (784), _enable_page_monitoring (880), ensure_valid_focus (321)
* `browser_use/browser/watchdogs/local_browser_watchdog.py` — on_BrowserLaunchEvent (49), _launch_browser (93), _find_installed_browser_path (220), _install_browser_with_playwright (360), _find_free_port (397), _wait_for_cdp_url (408)
* `browser_use/browser/_cdp_timeout.py` — TimeoutWrappedCDPClient (91), send_raw wait_for (108)
* `browser_use/browser/events.py` — all events, incl. NavigateToUrlEvent (110), SwitchTabEvent (169), BrowserStartEvent (292), storage/download/captcha events
* `browser_use/browser/views.py` — TabInfo (17), BrowserStateSummary (90), BrowserError (154)
* `browser_use/browser/chrome.py` — find_chrome_executable (38), get_chrome_profile_path (72)
* `browser_use/browser/cloud/cloud.py` — CloudBrowserClient.create_browser (27)/stop_browser (106)
* `browser_use/browser/__init__.py` — lazy-import shim (10-34); `BrowserSession as Browser` alias at top-level `browser_use/__init__.py:84-85/140-141`

## Connections map

### Inbound (who depends on this layer)
* **Agent loop** (agent/service.py): `browser_session.start()` (2566/3141), `get_browser_state_summary()` (1090, 3361-3449), initial navigate (465). Injects `browser_session: BrowserSession` param into custom tools by name (docs).
* **Tools/Registry** (tools/service.py + tools/registry): actions `navigate`, `switch_tab`, `close_tab`, `click`, etc. dispatch the events above into this layer and receive BrowserError.
* **DOM service** (dom/): SerializedDOMState/EnhancedDOMTreeNode produced on BrowserStateRequestEvent (handled by DOMWatchdog), consumed back via selector maps (update_cached_selector_map / get_element_by_index).
* **actor/ Page** (actor/page.py): wraps a target_id; cdp_client (46), session id (412), cdp_client_for_node (478).
* **config system** (browser_use/config.py): CONFIG for default user-dir/extions dir/docker detection; BrowserProfile validators use it.
* **storage_state subsystem**: StorageStateWatchdog subscribes (auto-save); kill()/stop() sync SaveStorageStateEvent; export_storage_state writes Playwright-format json.
* **filesystem/download**: DownloadsWatchdog + LocalBrowserWatchdog temp dirs; `--downloads-path`, downloads streaming.

### Outbound (what this layer depends on)
* **cdp_use** (external lib): CDPClient WebSockets, typed send.* domains, register.* event hooks, Target/TargetID/essionID types.
* **bubus** (external): EventBus/BaseEvent.
* **Browser-Use cloud API** (cloud/): create/stop browser via https, only in cloud mode.
* **Local OS**: Chrome/Chromium binaries (chrome.py, playwright fallback), temp dirs, `--remote-debugging-port`, env vars `BROWSER_USE_CDP_TIMEOUT_S`.
* **watchdogs** (12+ attached in attach_all_watchdogs): each receives the shared event_bus + session reference.

## Impact analysis

- **Single source of truth inversion**: all page-readiness signals (`Page.lifecycleEvent` routing, `targetInfoChanged` updates) converge in `SessionManager`, so Agent step latency is gated by this layer: a navigate returns only after the per-target lifecycle buffer hits `load`/`networkidle` (`_navigate_and_wait`).
- **Tab switching is purely focus-based**: `agent_focus_target_id` decides which target every click/type/extract targets. Downstream pages (DOM, screenshot, element resolve) re-derive their CDP session from it via `get_or_create_cdp_session()`, so any bug here (stale focus, focus on iframe) breaks all tools.
- **Failure modes are contained here**: WS dead → auto-reconnect (up to ~54s); focused tab detach → auto-recovery to most recent tab or a new/emergency tab. This is why the agent loop rarely "sees" browser crashes (they are swallowed by recovery tasks).
- **Keep-alive/cleanup semantics**: `on_BrowserStopEvent` respects `profile.keep_alive`; kill() vs stop() (force vs graceful) determines whether the Chrome subprocess is torn down — affects cloud billing and fs temp-dir leaks if misused.
- **Stealth/perf tuning lives entirely in profile args** (disable-automation flag masking, extension loading: uBlock+cookie handler+Force Background Tab, disabled Chromium components). Enabling `enable_default_extensions` triggers network downloads of .crx on first run (can be slow/offline failure); that happens at BrowserProfile construction (`model_post_init`→_copy_profile).

## Gotchas / Quirks

1. **`BrowserProfile.model_post_init` does `shutil.copytree` in the constructor** (`_copy_profile`, profile.py:838): constructing a session with a real Chrome `user_data_dir` copies the whole profile to a temp dir (or raises a lock error) — surprising cost/behavior at object-construction time.
2. **cdp-use's event registry is single-slot per CDP method**: per-session registration of `Page.lifecycleEvent` would clobber the previous tab's handler, so SessionManager uses ONE global handler routed by `session_id` (session_manager.py:112-127; explains `_lifecycle_events` on CDPSession).
3. **connect() 15s global timeout** in `start()` (session.py:831) — on timeout it manually unwinds a partially-initialized client; `CancelledError` bypasses connect()'s own `except Exception` cleanup, hence the explicit cleanup block.
4. **Proxy auth uses CDP `Fetch.enable(handleAuthRequests)` + continueWithAuth** with a browser-visible "Default" fallback for non-proxy challenges (session.py:2020-2147).
5. **Focus is only set for `page`-typed targets** — iframe/worker sessions must never receive focus (guarded at session.py:1528-1546), else the agent_focus points at a detaching target.
6. **`is_cdp_connected` checks the WebSocket State.OPEN** of `_cdp_client_root.ws`, so handlers skip dispatch on a dead WS instead of hanging (session.py:500-515), complemented by TimeoutWrappedCDPClient per-request caps.
7. **Chrome `http://` cdp_url** → the code fetches `/json/version` and swaps in `webSocketDebuggerUrl`; `trust_env=False` only for localhost to avoid proxied env vars (session.py:1870-1878).
8. **Duplicate-handler guard**: constructing two sessions on the same bus raises ("Duplicate handler registration") — a known multi-init footgun (session.py:700-708).
9. `keep_alive` + Agent.close() leaves the browser running but the bus nulled; `ResilientEventBus.step/wait_until_idle` no-op on torn-down bus/async primitives (session.py:118-131) to support warm-Lambda resume (ENG-5280).
10. `Browser` and `BrowserSession` are the **same class** (top-level alias), and `from browser_use.browser import ...` uses a `__getattr__` lazy-import shim.