# crawl4ai — Core AsyncWebCrawler Pipeline (Deep-Dig Report)

## 1. Feature

**The AsyncWebCrawler `arun()` pipeline**: the synchronous-per-URL flow from a caller-supplied URL through page fetch (Playwright or aiohttp), conditional wait/render/JS, content scraping → markdown → structured extraction, cache read/write, anti-bot/proxy retry, and finally construction of a `CrawlResult`. Deep crawling (BFS/DFS/best-first link following) is layered on top as a *decorator* and, per the task brief, is included here because it sits directly on the main path.

## 2. One-paragraph summary

When a caller invokes `await crawler.arun(url, config)`, a `DeepCrawlDecorator` (installed over `arun` at construction) either hands off to a deep-crawl strategy (e.g. `BFSDeepCrawlStrategy`, which fans out through repeated `arun_many` → `arun` calls) or delegates to the real `arun`. `arun` then: consults a `CacheContext` to optionally short-circuit from the SQLite cache (with optional "Smart Cache" ETag/fingerprint validation); if a miss, it runs an anti-bot retry loop across proxies that calls `crawler_strategy.crawl()` — which for http(s) URLs builds/rules a Playwright page (goto, wait/render phases: full-page scan, `wait_for`, JS hooks before/after, optional network/console capture) or, for `AsyncHTTPCrawlerStrategy`, a fetch via aiohttp — producing an `AsyncCrawlResponse`. That response's HTML then flows into `aprocess_html()`, which runs the config's `ContentScrapingStrategy` (default LXML) to produce clean HTML/links/media/tables, then the `MarkdownGenerationStrategy`, then (if configured) structured extraction. The assembled `CrawlResult` is optionally written back to the cache and returned wrapped in a `CrawlResultContainer` (a backward-compat proxy whose `.markdown` is a `StringCompatibleMarkdown` string-plus-object).

## 3. Architecture / call-chain diagram (text)

```
caller
  │ crawler.arun(url, config)                    [async_webcrawler.py:210]
  ▼
DeepCrawlDecorator.__call__ (wrapped_arun)       [deep_crawling/base_strategy.py:17]
  │ config.deep_crawl_strategy set? ──yes──▶ config.deep_crawl_strategy.arun(crawler,start_url,config)
  │   └─ DeepCrawlStrategy.arun                    [base_strategy.py:82]
  │       ├─ stream ? _arun_stream : _arun_batch   [bfs_strategy.py:207/303]
  │       │   loop: current_level                 (BFS level)
  │       │   └─ crawler.arun_many(urls, batch_cfg.deep_crawl_strategy=None)
  │       │        └─ dispatcher.run_urls/run_urls_stream  [async_dispatcher.py:320,704]
  │       │             └─ crawler.arun(per-url) ◀── recursion, now deep_crawl_active=True → real arun
  │       └─ link_discovery(result,url,depth,visited,next_level)  [bfs_strategy.py:133]
  │           └─ can_process_url/FilterChain.apply + URLScorer.score
  │ no deep strategy ────────────────▶ original arun           [async_webcrawler.py:210]
  │
  ▼
AsyncWebCrawler.arun
  │ auto-start crawler (strategy.__aenter__)        [async_webcrawler.py:247,183]
  │ CacheContext(url, cache_mode).should_read()?     [cache_context.py:59]
  │   ├─▶ acache read: async_db_manager.aget_cached_url(url)   [async_database.py:299]
  │   │        └─ Smart Cache validate (check_cache_freshness) [async_webcrawler.py:279-319]
  │   │             CacheValidator.validate(etag/last_modified/fingerprint) [cache_validator.py]
  │   │        fresh → replay cached_result ─▶ CrawlResultContainer(cached) return   [:691]
  │   └─ proxy rotation (sticky/session)            [async_webcrawler.py:351-377]
  │
  │  MISS: robots check (check_robots_txt)           [async_webcrawler.py:384-397]
  │  anti-bot loop _max_attempts × _proxy_list:
  │    ▶ crawler_strategy.crawl(url, config)         [async_webcrawler.py:459-460]
  │      AsyncPlaywrightCrawlerStrategy.crawl        [async_crawler_strategy.py:46,436]
  │        ├─ http(s)/view-source → _crawl_web        [async_crawler_strategy.py:514]
  │        │     browser_manager.get_page             [async_crawler_strategy.py:567]
  │        │     hooks: on_page_context_created        [:615]
  │        │     (degrade) capture_network/console
  │        │     page.goto(url, wait_until, timeout)   [:762]
  │        │       │ redirect-chain walk for first status [:791-800]
  │        │     hooks: before_goto, after_goto         [:725,:802]
  │        │     body visibility / csp_compliant_wait    [:812-844]
  │        │     full-page scan / virtual scroll        [:948,:997]
  │        │     JS phases: js_code_before_wait [:965] -> wait_for smart_wait [:987-994]
  │        │              js_code (js_execution) [:1007] -> hooks on_execution_* [:1019-20]
  │        │     DOM tweaks: image dims / iframes / consent popup / overlays [:1025-1050]
  │        │     html capture: shadow flatten / css_selector / page.content() [:1054-1085]
  │        │      hooks: before_retrieve_html, before_return_html [:1001,:1087]
  │        │     optional: page.pdf / mhtml / screenshot(s) [:1097-1112]
  │        │     → AsyncCrawlResponse(html,headers,status,redirects,media,network,console) [:1147-1165]
  │        └─ file:/raw: → fast path or _crawl_web(set_content)   [:462-508]
  │      AsyncHTTPCrawlerStrategy.crawl (no-browser engine) [async_crawler_strategy.py:2798]
  │        └─ _handle_http via session.request(BASE_HEADERS,proxy) [:2716-2776] binary downloads→disk
  │      └─ convert → aprocess_html(url, html, config, screenshot, pdf, ...)  [async_webcrawler.py:474]
  │           └─ PER-FLOW: prefetch short-circuit (link-only)       [async_webcrawler.py:772-761]
  │           └─ ContentScrapingStrategy.scrap → ScrapingResult    [async_webcrawler.py:783-784]
  │                └─ LXMLWebScrapingStrategy scrap (_scrap)        [content_scraping_strategy.py:122]
  │           └─ MarkdownGenerationStrategy.generate_markdown      [async_webcrawler.py:871-876]
  │                └─ DefaultMarkdownGenerator (html2text + citations) [markdown_generation_strategy.py:148]
  │           └─ (if strategy set) ExtractionStrategy.arun/exor.chunk   [async_webcrawler.py:905-949]
  │           └─ CrawlResult(...)                       [async_webcrawler.py:956-971]
  │
  │  anti-bot is_blocked? → cleanup / mark blocked   [async_webcrawler.py:544-646]
  │  fallback_fetch_function if configured            [async_webcrawler.py:553-610]
  │  head_fingerprint compute for cache-validation    [:648-653]
  ▼
cache write (CacheContext.should_write) → acache_url   [async_webcrawler.py:671-672, async_db.py:478]
CrawlResultContainer(crawl_result) → caller             [async_webcrawler.py:674]
```

## 4. Key files + line references

| Concern | File:line |
|---|---|
| Public entry / lifecycle | `crawl4ai/async_webcrawler.py:115` (`__init__`), `:176` `start`, `:188` `close`, `:205` nullcontext |
| Deep-crawl decorator install | `async_webcrawler.py:170-171` |
| **`arun` (the core loop)** | `async_webcrawler.py:210`, cache read `:275`, smart-cache `:279-319`, proxy/anti-bot loop `:419-510`, fallback `:553-610`, blocked→fail `:621-646`, cache write `:671` |
| **`aprocess_html`** | `async_webcrawler.py:715`; scrape `:783`; markdown `:871`; extraction `:895`; result build `:956` |
| **`arun_many`** | `async_webcrawler.py:973`; deep branch `:1032`; dispatcher default `:1054` |
| Strategy ABC / dispatch | `async_crawler_strategy.py:36` |
| **`AsyncPlaywrightCrawlerStrategy.crawl`** | `async_crawler_strategy.py:436`; `_crawl_web` `:514`; goto `:762`; wait phase `:987`; HTML capture `:1085`; response build `:1147` |
| Hooks system | `:164` `set_hook`, `:190` `execute_hook`, fired `:615,:725,:802,:1001,:1087,:1019-20` |
| **`AsyncHTTPCrawlerStrategy`** | `:2466`, `crawl` `:2798`, `_handle_http` `:2679` |
| Deep crawl decorator / ABC | `deep_crawling/base_strategy.py:10`,`:45` |
| **`BFSDeepCrawlStrategy`** | `deep_crawling/bfs_strategy.py:16`, `_arun_batch` `:207`, `_arun_stream` `:303`, `link_discovery` `:133`, `can_process_url` `:62` |
| Filters/scorers | `deep_crawling/filters.py`, `deep_crawling/scorers.py` |
| **`CrawlResult`** model | `models.py:130`; private `_markdown` + `StringCompatibleMarkdown` `:143,:188,:277`; `MarkdownGenerationResult` `:120` |
| Logger | `async_logger.py:80` (`AsyncLogger`), `:280` `url_status`, `:315` `error_status` |
| Cache decision | `cache_context.py:4` (modes), `:23` `CacheContext`, `:59/:88` read/write |
| Cache validator | `cache_validator.py:42` |
| DB | `async_database.py:299` aget_cached, `:392` metadata, `:478` acache |
| Scraping | `content_scraping_strategy.py:101` LXML, `:122` scrap |
| Markdown | `markdown_generation_strategy.py:26` ABC, `:55` Default, `:82` citations, `:148` generate |
| Dispatcher hooks into arun | `async_dispatcher.py:320,704` |
| Shared config | `async_configs.py:1693` deep str., `:1726` scrap start. `:1869` `deep_crawl_strategy`, `:1940` `_get_proxy_list` |

(Verify line refs against the files above — all checked against the actual source while writing.)

## 5. Connections map

**Inbound (who feeds `arun`):**
- `arun_many` (dispatched fan-out) → per-URL `arun` (`async_webcrawler.py:459`+dispatcher `320/704`)
- Deep-crawl strategies re-enter `arun` via `crawler.arun_many` — recursion is guarded by `deep_crawl_active` ContextVar (`base_strategy.py:12,21`).
- CLI entrypoints (`crawl4ai/cli.py`, cloud clients) and external integrator/users.

**Outbound (where `arun`'s data flows):**
- `AsyncCrawlResponse` → `aprocess_html` → `ContentScrapingStrategy` (LXML) → `MarkdownGenerationStrategy` → `ExtractionDataStrategy`/Chunking — all config-driven via `CrawlerRunConfig`.
- SQLite cache DB (`async_database.py`) reads and writes; Smart Cache validator.
- Download dir (aiohttp binary path) and `SSLCertificate.from_url`.

## 5. Impact analysis

- The pipeline is the single funnel: *everything* (web, raw HTML, local file, PDF-browser, deep crawl, batch/stream) funnels into `arun`/`aprocess_html`, so caching, anti-bot retry, and the `CrawlResultContainer` explain the whole system's return shape and logging (FETCH/SCRAPE/EXTRACT/COMPLETE tags in `async_logger`).
- `CrawlResult.markdown` being a `StringCompatibleMarkdown` (a `str` subclass) keeps legacy consumers working while exposing the new structured `markdown` (`.fit_markdown` now raises on CrawlResult directly, moved under `.markdown`).
- Deep-crawling couples to `arun_many`'s stream/batch contract — dispatcher cannot handle a `List[CrawlResult]` return, so `arun_many` bypasses the dispatcher when a deep plan runs (`async_webcrawler.py:1031-1052`), and BFS clones config with `deep_crawl_strategy=None` to avoid recursion.
- Cache staleness (e.g. screenshots/PDF missing from cache) force a re-crawl (`async_webcrawler.py:337-341`).
- Anti-bot/proxy * changes `config.proxy_config` temporarily and restores it; the fallback path treats the fallback result as authoritative to avoid false anti-bot positives.

## 6. Gotchas / quirks found

1. **Cache + `raw:` URLs**: `CacheContext.is_cacheable` excludes `raw:` URLs (`cache_context.py:53`), so raw HTML is never cached.
2. **Binary-download success**: a PDF/archive has empty HTML by design; `success` is set to `bool(html) or bool(downloaded_files)` and the block check is skipped (`async_webcrawler.py:502,627-628`).
3. **`fit_markdown` pitfall**: empty unless a `content_filter` is configured; falls back to `markdown` for extraction (`async_webcrawler.py:903-911`).
4. **Fallback vs proxy-authoritative logic**: only skip the block re-check when `resolved_by == "fallback_fetch"` — a caller that sets `fallback_fetch_function` must swallow `CrawlResultContainer` correctly.
5. **Session pages**: reuse pages leak listeners unless deliberately torn down in `finally` (`:1170-1184`); session pages are not closed, only non-session non-managed ones.
6. **`is_local_content` detection repeated** in both branches (goto vs set_content) and later for redirects — duplicated prefix logic (`raw:/raw:///file://`) is a minor dryness smell.
7. **`html2text`/queue ordering** — markdown citation numbering is deterministic by first-seen, but the `LINK_PATTERN` relies on a regex that can be thrown by malformed anchor text.

*(Report drafted for the research task; targets Analysis/AsyncWebCrawler pipeline. All `file:line` refs sourced directly from the target repo.)*