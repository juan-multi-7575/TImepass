# Feature Report: StealthyFetcher / Camoufox Integration

> **Repo:** scrapling (v0.4.15) — `analysis-repos/Scrapling`
> **Feature:** `StealthyFetcher` / `StealthySession` — undetectable browser fetching (formerly Camoufox-engine, now Patchright-engine)

## Summary

`StealthyFetcher` is Scrapling's hardened, anti-bot-bypassing fetcher. It is a thin classmethod facade (`scrapling/fetchers/stealth_chrome.py:7`) that constructs a `StealthySession` / `AsyncStealthySession` browser session (`scrapling/engines/_browsers/_stealth.py:23,314`) which launches a **Patchright-patched Chromium** (replaced Camoufox/Firefox in v0.3.13) via `patchright.sync_api/async_api` (`_stealth.py:8-9`). The session layers on stealth by combining: (1) launch flags (`STEALTH_ARGS`, `DEFAULT_ARGS`, `HARMFUL_ARGS` stripped from the child's view via `ignore_default_args`, `scrapling/engines/constants.py:15-97`), (2) a fixed, realistic context fingerprint (`color_scheme=dark`, `device_scale_factor=2`, 1920x1080 screen/viewport, permissions, `is_mobile=False`, `_base.py:444-556, 542-579`), (3) browserforge-generated real headers/User-Agent matched to the driven Chromium major version (`toolbelt/fingerprints.py:66-90`), (4) optional canvas-noise, WebRTC-blocking, WebGL toggles, DNS-over-HTTPS, and domain/resource request interception (`_base.py:559-579`, `navigation.py:43-130`), and (5) an optional Cloudflare Turnstile/Interstitial solver that detects challenge types from page text and physically clicks the captcha widget (`_stealth.py:108-193`, `_base.py:581-628`). A request flows: `url` → classic browser launch/context-per-proxy → page from a pooled `PagePool` (`_page.py:46-108`) → `page.goto` with Google referer + extra headers → stability waits → optional CF solve → response handler captures the navigation response + optional XHR → `ResponseFactory.from_playwright_response` builds a `Selector`-based `Response` (`convertor.py:83-152`) that is returned and immediately usable for parsing. Proxy handling supports static proxy, per-request proxy override (fresh context per proxy, `_page_generator`, `_base.py:189-227`), and thread-safe `ProxyRotator` rotation.

## Architecture / Call-Chain (text diagram)

```
User code
  └─ StealthyFetcher.fetch(url, **kwargs)        fetchers/stealth_chrome.py:62
       ├─ kwargs["selector_config"] = {...parser args}                 stealth_chrome.py:60
       └─ with StealthySession(**kwargs) as engine:                    _stealth.py:23
            ├─ __init__ → __validate__(**kwargs)                      StealthySessionMixin._base.py:542
            │     ├─ __validate_routine__ (BaseSessionMixin)          _base.py:440
            │     │    ├─ _context_options = {color_scheme:"dark", device_scale_factor:2}
            │     │    ├─ _browser_options = {args: DEFAULT_ARGS, ignore_default_args: HARMFUL_ARGS}
            │     │    ├─ validate(params, StealthConfig)             _validators.py:246 (msgspec convert)
            │     │    └─ StealthConfig.__post_init__                 _validators.py:150 (bump timeout→60s if solve_cloudflare)
            │     ├─ context options: is_mobile/has_touch/screen/viewport/permissions…  _base.py:545-556
            │     └─ __generate_stealth_options()                     _base.py:559
            │          ├─ flags = DEFAULT_ARGS + STEALTH_ARGS          _base.py:563
            │          │   + --webrtc-ip-handling-policy if block_webrtc _base.py:565-569
            │          │   + --disable-webgl* if not allow_webgl      _base.py:570-575
            │          │   + --fingerprinting-canvas-image-data-noise if hide_canvas _base.py:576-577
            │          └─ → __generate_options__ (useragent, locale, --lang/--accept-lang,
            │               dns-over-https --dns-over-https-templates, channel=chrome|chromium)  _base.py:459-517
            └─ start()  (via `with`)                                  _stealth.py:77
                 ├─ patchright sync_playwright().start()
                 ├─ branch: cdp_url        → chromium.connect_over_cdp        _stealth.py:83-87
                 ├─ branch: proxy_rotator  → chromium.launch(**browser_opts)  _stealth.py:88-89
                 └─ default                → chromium.launch_persistent_context(…user_data_dir)  _stealth.py:91-94
                 └─ _initialize_context (init_script + cookies)               _base.py:99-107
                 └─ engine.fetch(url)                                      _stealth.py:195
                      ├─ _validate(kwargs, self, StealthConfig)              _validators.py:178
                      ├─ referer = "https://www.google.com/" if google_search
                      ├─ retry loop (config.retries, default 3)
                      ├─ proxy = rotator.get_proxy() or static_proxy          proxy_rotation.py:88
                      ├─ _page_generator(...)                                _base.py:189
                      │    ├─ no proxy → PagePool.get_ready_page()/new_page   _page.py:78,62
                      │    └─ proxy    → browser.new_context(**context.proxy)→ fresh ctx, _build_context_with_proxy _base.py:519
                      ├─ page.on("response", _create_response_handler)        _base.py:156
                      ├─ params.page_setup(page) (pre-nav hooks)
                      ├─ first_response = page.goto(url, referer=referer)
                      ├─ _wait_for_page_stability(load_dom, network_idle)     _base.py:149
                      ├─ if solve_cloudflare: _cloudflare_solver(page)        _stealth.py:108 (capped __CF_MAX_SOLVE_ATTEMPTS__=3)
                      │    ├─ _detect_cloudflare(page content)                _base.py:582
                      │    ├─ non-interactive → poll until gone
                      │    └─ managed/interactive/embedded → find "#cf-turnstile…" iframe
                      │         → mouse.click(randint coords, delay) → poll _challenge_cleared
                      ├─ params.page_action(page) (post-nav automation)
                      ├─ wait_selector / wait_for_timeout(wait)
                      └─ ResponseFactory.from_playwright_response(page, first, final, selector_config, meta={proxy}, xhr_captured)  convertor.py:83
                           ├─ html? → page.content() (retried 20x, handles Playwright+PatchrightError)  convertor.py:200-212
                           ├─ cookies = page.context.cookies(); history via redirected_from  convertor.py:40-80
                           └─ → Response(url, content, status, reason, cookies, headers, …)  toolbelt/custom.py:42
                                 └─ inherits Selector (CSS/XPath/… parsing surface)  parser.py
```

The async twin `AsyncStealthySession` mirrors every step with `async_playwright()` and `await` (async version of `start`, `_cloudflare_solver`, `fetch` at `_stealth.py:363-599`).

## Key Files + Verified Line Refs

### Fetcher facade
| Symbol | File:Line |
|---|---|
| `StealthyFetcher.fetch` | `scrapling/fetchers/stealth_chrome.py:14` |
| `StealthyFetcher.async_fetch` | `scrapling/fetchers/stealth_chrome.py:66` |
| engine construction + `engine.fetch(url)` | `stealth_chrome.py:62-63`, `114-115` |
| backward-compat `custom_config` handling | `stealth_chrome.py:54-60` |

### Engine layer
| Symbol | File:Line |
|---|---|
| `class StealthySession(SyncSession, StealthySessionMixin)` | `scrapling/engines/_browsers/_stealth.py:23` |
| `StealthySession.start` (launch branches: CDP / rotator / persistent ctx) | `_stealth.py:77-106` |
| engine imports: `patchright.sync_api`/`async_api` (NOT Camoufox, NOT plain playwright) | `_stealth.py:8-9` |
| `StealthySession._cloudflare_solver` (sync) | `_stealth.py:108-193` |
| `StealthySession.fetch` (retry loop, response wiring) | `_stealth.py:195-311` |
| `ResponseFactory.from_playwright_response` call | `_stealth.py:283-290` |
| `class AsyncStealthySession(AsyncSession, StealthySessionMixin)` | `_stealth.py:314` |
| `AsyncStealthySession.start` | `_stealth.py:363-391` |
| async `_cloudflare_solver` | `_stealth.py:393-480` |
| `AsyncStealthySession.fetch` | `_stealth.py:482-599` |
| `__CF_PATTERN__` & `__CF_MAX_SOLVE_ATTEMPTS__` | `_stealth.py:19-20` |

### Shared browser base (inherited from DynamicFetcher's foundation)
| Symbol | File:Line |
|---|---|
| `SyncSession` base (page pool, context, close, `_page_generator`) | `_base.py:48-227` |
| `SyncSession.start` (patchright handles the "stealth driver" launch) | `_stealth.py:77` (overrides base) |
| `BaseSessionMixin.__validate_routine__` (dark scheme, device_scale_factor, browser opts) | `_base.py:440-457` |
| `BaseSessionMixin.__generate_options__` (UA, locale flags, DoH, channel) | `_base.py:459-517` |
| `StealthySessionMixin.__validate__` (context fingerprint: touch/service_workers/ignore_https_errors/1920x1080/permissions) | `_base.py:542-556` |
| `StealthySessionMixin.__generate_stealth_options` (STEALTH_ARGS + webrtc/webgl/canvas flags) | `_base.py:559-579` |
| `_initialize_context` (init_script, cookies) | `_base.py:99-107` |
| `_create_response_handler` (capture nav doc response + XHR by pattern) | `_base.py:156-187` |
| `_page_generator` (proxy: fresh context/`_build_context_with_proxy`; else PagePool) | `_base.py:189-227`, `519-533` |
| `_wait_for_page_stability` / `_wait_for_networkidle` (tolerates never-idle pages) | `_base.py:141-154` |
| `_detect_cloudflare` (cType: '...' or embedded turnstile script) | `_base.py:581-614` |
| `_challenge_cleared` | `_base.py:617-628` |
| `SyncSession`/`AsyncSession` close, `get_pool_stats` | `_base.py:72-90,133-139` |

### Config / validation / types
| Symbol | File:Line |
|---|---|
| `StealthConfig(PlaywrightConfig)` — stealth fields `allow_webgl/hide_canvas/block_webrtc/solve_cloudflare` | `_validators.py:144-148` |
| `__post_init__` → force timeout ≥ 60_000 when `solve_cloudflare` | `_validators.py:150-155` |
| `PlaywrightConfig` (shared browser config incl. `retries`3, `block_ads`→AD_DOMAINS merge) | `_validators.py:59-141` |
| `validate` / `validate_fetch` (msgspec, filtering defaults, per-request override lifting) | `_validators.py:178-251` |
| `StealthSession` TypedDict (extends `PlaywrightSession`) | `_typpes.py:117-121` |
| `StealthFethParams` | `_typpes.py:124-125` |
| `DEFFAULT_ARGS` / `HARMFUL_ARGS` / `STEALTH_ARGS` flag sets | `constants.py:15-97` (`STEALTH_ARGS` at 39) |

### Toolbelt (shared engine helpers)
| Symbol | File:Line |
|---|---|
| `ResponseFactory.from_playwright_response` (+ history, charset, html-vs-bytes content logic, XHR→Response conversion) | `toolbelt/convertor.py:83-152` |
| `_get_page_content` retry loop catching `PlaywrightError`+`PatchrightError` | `convertor.py:200-212` |
| `Response(Selector)` unified response class (+ `captured_xhr`, `meta`, `follow`) | `toolbelt/custom.py:28-163` |
| `BaseFetcher` (parser arg plumbing: `selector_config`, `configure(...)`) | `toolbelt/custompy:166-243` |
| `create_intercept_handdler` / async twin (disable_resources + blocked_domains w/ suffix walk) | `toolbelt/navigation.py:43-94` |
| `construct_proxy_dict` (str/dict → Playwright proxy) | `navigation.py:97-130` |
| `ProxyRotator` (thread-safe, cyclic default, `is_proxy_error` indicators) | `toolbelt/proxy_rotation.py:39-104`, `7-30` |
| `generate_headers` (browserforge headers + patchright-driven Chromium version pin of Chrome UA) | `fingerprints.py:66-90` |
| `__default_useragent__` / `__default_chrome_useragent__` | `_config_tools.py:3-4` |

### Page pooling
| Symbol | File:Line |
|---|---|
| `PageInfo` (states ready/busy/error) | `_page.py:13-43` |
| `PagePool` (thread-safe pool, `max_pages` cap, reuse) | `_page.py:46-108` |
| pool stats surfaced | `_base.py:133` (sync) / `_base.py:333` (async) |

### Public exposure & connections
| Symbol | File:Line |
|---|---|
| `scrapling.fetchers.__init__` lazy import map (`StealthyFetcher`/`StealthySession`/`AsyncStealthySession`) | `fetchers/__init__.py:18-20,11-21` |
| top-level `scrapling.__init__` (`from scrapling import StealthyFetcher`) | `scrapling/__init__.py:21,24` |
| `scrapling stealthy_fetch` CLI command | `scrapling/cli.py:627-697` |
| safari site2 fetchers dep (playwright + patchright extra) | `pyproject.toml:73-83` |
| `scrapling install` (installs playwright chromium + deps) | `cli.py:120-142` |

## Connections Map

### Inbound (who calls StealthyFetcher/sessions)
- **User public API** — `from scrapling import StealthyFetcher` exposes it at package root (`__init__.py:21,24`); `from scrapling.fetchers import StealthyFetcher, StealthySession, AsyncStealthySession` (`fetchers/__init__.py:18-20`).
- **CLI** — `scrapling extract stealthy_fetch` subcommand builds kwargs from Click options (`cli.py:627-697`) and calls `StealthyFetcher.fetch` (`cli.py:697`). Browser options shared lexicon via `_common_browser_options` (`cli.py:294`).
- **Web scraping shell (IPython)** — `scrapling/core/shell.py:397-411,514` exposes `stealthy_fetch` shortcut wrapper with runtime signatures from `_hell_signatures.py:72-108`; classes injected (`shell.py:528-533`).
- **MCP/ai modult** — `scrapling/core/ai.py` (a) `open_browser_session(session_type="stealthy")` constructs `AsyncStealthySession(**common_kwargs, hide_canvas, block_webrtc, allow_webgl…)` `ai.py:289-301`; (b) one-shot `stealthy_fetch`/`bulk_stealthy_fetch` tools run inside `async with AsyncStealthySession(...)` `ai.py:886-904`, `734,825`; registered as MCP-tool `stealthy_fetch` `ai.py:1152-1161`. Guards pass `solve_cloudflare` only for stealthy sessions (`tests/ai/test_ai_mcp.py:514-527`).
- **Spiders framework** — `scrapling/spiders/session.py:7,9` unions `AsyncStealthySession` into `Session` for `SessionManager`; `SessionManager.fetch` dispatches `session.fetch(url, **request._session_kwargs)` `session.py:128`.
- **Tests** — `tests/fetchers/sync/test_stealth_session.py` (CF detection + pooling reuse), `tests/ai/test_ai_mcp.py`, `tests/cli/test_cli.py:229,280,290`.

### Outbound (what StealthyFetcher depends on)
- `patchright` (stealth driver/Chromium) + `playwright` (typings, error classes, Page/Locator objects) — `_stealth.py:6-9`.
- `StealthySessionMixin`/`SyncSession`/`AsyncSession` — `_base.py:542,48,229`.
- `StealthConfig`/`_validate`/`validate_fetch` — `_validators.py:144,178,246`.
- `StealthSession`/`StealthFetchParams` TypedDicts — `_types.py:117,124`.
- `ProxyRotator`/`is_proxy_error` — `toolbelt/proxy_rotation.py:13,27,39`.
- `ResponseFactory`/`Response` — `toolbelt/convertor.py:17,83,230`; `toolbelt/custom.py:28`.
- `construct_proxy_dict`/`create_(async)_intercept_handler` — `toolbelt/navigation.py:43,70,97`.
- `generate_headers` (UA/fingerprint) & modulo `constants.py` flags — `fingerprints.py:66`, `_config_tools.py:3`.
- `PagePool`/`PageInfo` — `_page.py:13,46`.
- `Selector` parsing (`parser.py`) — inherited by `Response` (`custom.py:28`).
- `scrapling.core._types`/`utils.log`.

### Sibling relationship: `DynamicFetcher` vs `StealthyFetcher`
Both share the SAME base machinery (`SyncSession`, `PagePool`, `_page_generator`, `ResponseFactory`, proxying, retries, intercept). Differences:
- Engine driver: DynamicFetcher → plain `playwright` (`_controllers.py:4-11`); StealthyFetcher → `patchright` (`_stealth.py:8-9`).
- Config model: `PlaywrightConfig` vs `StealthConfig` (`_validators.py:59,144`).
- Mixin: `DynamicSessionMixin` adds nothing (`_base.py:536-539`); `StealthySessionMixin` adds stealth launch flags + fixed fingerprint context (`_base.py:542-579`).
- Stealth-only args: `solve_cloudflare`, `hide_canvas`, `block_webrtc`, `allow_webgl` (`_types.py:117-121`; CLI `cli.py:630-645`; shell sig `_shell_signatures.py:104-107`).
- DynamicFetcher accepts `stealth`/`hide_canvas` args? No — removed since v0.3.13 (breaking change; `stealth` flag removed, `hide_canvas`/`allow_webgl` moved to stealthy). See CHANGELOG v0.3.13 breaking changes.

## Impact Analysis

1. **Anti-bot runtime** — `StealthyFetcher` is the only channel that can take on Cloudflare Turnstile/Interstitial, WAFs, CDP/WebRC leak checks. It gates Scrapling's "hard protection" story (docs `fetching/ettrealthy.md`, index claims "bypass all types of Cloudflare's Turnstile").
2. **Dependency/instad footprint** — patchright in `fetchers` extra (`pyproject.toml:77`) drove a 60% smaller Docker image / install time vs Camoufox (CHANGELOG v0.3.13). `scrapling install` still only installs `playwright chromium`+deps (`cli.py:120-142`); patchright ships its own patched Chromium and needs its own fetch path (`python -m patchright install chromium`) — a real operational gotcha.
3. **Performance** — 101% speedup vs the old Camoufox flow (CHANGELOG v0.3.13), reusing one persistent context + PagePool across requests; pages are kept open since v0.4.15 (settings reset per reuse). Memory use lower than the Firefox/Camoufox era.
4. **System-wide configuration leaks** — `StealthConfig.timeout` get bumped to ≥60s automatically when `solve_cloudflare=True` (`_validators.py:150-155`), which changes user-visible timing on every request in a session.
5. **API surface ripple** — every consumer of browser sessions (CLI, shell, MCP, spiders `SessionManager`) must choose `stealthy` vs `dynamic`; MCP explicitly forbids `solve_cloudflare` on dynamic sessions (ai.py tests). Any change to the stealth engine ABI (e.g., re-introducing Camoufox) ripples into `_start` overrides, docs' "Using Camoufox as an engine" subclass example (`docs/fetching/stealthy.md:264-342`), and the MCP session factory (`ai.py:289-301`).
6. **Behavioral divergence risk** — because `stealthy_fetch` and `fetch` share the CLI `_ParseHeaders`/`_common_browser_options` plumbing but pass different kwarg families, option drift between `DynamicFetcher` and `StealthyFetcher` is easy to introduce.

## Gotchas / Quirks

- **Engine is Patchright, NOT Camoufox (as of v0.3.13+).** The README/docs historical naming and this report's task name reference Camoufox; the shipped code imports `patchright.*`. Camoufox only survives as a documented subclass recipe (`docs/fetching/stealthy.md:264-342`) and in the changelog. Chrome binary from `patchright` is the default "Camoufox replacement"; `real_chrome=True` uses installed Chrome instead.
- **CLI install mismatch** — `scrapling install` runs `python -m playwright install chromium`, which does NOT install patchright's patched browser; on a fresh machine StealthyFetcher can fail to find its executable until `python -m patchright install chromium` is run separately.
- **Persistent context, not browser**, normally — no `proxy_rotator`/`cdp_url`: `launch_persistent_context` with a temp `user_data_dir` (`_stealth.py:91-94`); so cookies/localStorage persist during the session. The `user_data_dir` is *only* respected in session classes (per docs).
- **`__CF_PATTERN__`/solver is heuristic + mouse-physics** — it locates the CF iframe `bounding_box()` then clicks at `+randint(26,28), +randint(25,27)` with `delay=randint(100,200)` (`_stealth.py:170-173`); failure paths return the page "as is" after 3 attempts (`_stealth.py:20,120-122`). Works only for the framework's known challenge selectors.
- **`_wait_for_networkidle` swallows errors** (`_base.py:146-147`) so an infinite-polling site won't crash—but also means a never-idle page returns early, possibly before XHR settled.
- **`load_dom` waits both `load` AND `domcontentloaded`** (`_base.py:149-154`) — non-obviously stricter than the docs' phrasing.
- **Content type switch** — if final `content-type` contains `html`, `Response.body` = rendered `page.content()` encoded utf-8 (post-`page_action`/CF solve DOM); otherwise raw `final_response.body()` (`convertor.py:124-128`) — so binary downloads aren't HTML-wrapped, but any HTML-flavored subtype is.
- **Response history limited to redirects** — `history` is built from `redirected_from` on the first response (`convertor.py:40-80`), not full multi-hop nav.
- **Cross-engine mixin trick** — `StealthySessionMixin.__generate_options__` is invoked via `super(...)` inside `__generate_stealth_options` (`_base.py:579`) to merge base browser opts; the result of mixing this order (kwargs override for `additional_args` last (`_base.py:516-517`).
- **`custom_config` alias deprecated** to `selector_config`; `selector_config` must be dict or TypeError (stealth_chrome.py:54-58).
- **`Page.action` on Stealthy runs in Patchright's isolated context** — `init_script` globals on `window` aren't visible unless `page.evaluate(..., isolated_context=False)` (docs note, `stealthy.md:89`).
- **Windows quirk** — v0.3.14 disabled incognito in Stealthy because cookies didn't persist across pages on Windows (#123); relevant if you feel like flipping `--incognito` back.

## Sources / Evidence

Code: `scrapling/fetchers/stealth_chrome.py`, `scrapling/engines/_browsers/{_stealth,_base,_types,_validators,_config_tools,_controllers,_page}.py`, `scrapling/engines/{constants,toolbelt/{convertor,custom,navigation,proxy_rotation,fingerprints,__init__}}.py`, `scrapling/cli.py`, `scrapling/core/{shell,_shell_signatures,ai}.py`, `scrapling/spiders/session.py`, `scrapling/__init__.py`, `fetchers/__init__.py`. Docs: `docs/fetching/stealthy.md`; `CHANGELOG.md` v0.3.13/v0.3.14; `pyproject.toml` deps.