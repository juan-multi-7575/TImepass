# Scrapling — Response Object & Parser Layer

## Feature

The unified response/parsing layer: a `Response` object (subclass of a tree-wrapping `Selector`) is
returned by *every* engine — `curl_cffi` static fetchers (sync + async), Playwright/Patchright
browser fetchers (sync + async), the spider framework, and AI/MCP integrations. It wraps parsed HTML
as lxml elements and exposes a parsel/Scrapy-flavoured selector API (CSS3 with `::text` /
`::attr(ATTR_NAME)` pseudo-elements, XPath with variable binding, `find_by_text`, `find_by_regex`,
`find_similar`, `re`/`re_first`, `json`) plus HTTP metadata (`status`, `reason`, `cookies`,
`headers`, `history`, `meta`, `captured_xhr`) and convenience methods (`urljoin`, `markdown`,
`follow`, `prettify`, `get_all_text`). This report covers the parsing backends, the selector
query surface, the response adapter factory, and the convenience/string-handler types. The
adaptive/auto-heal sub-feature is covered in the sibling report `report-adaptive-selection.md`;
storage is referenced but not re-dug here.

## One-Paragraph Summary

`Response` (engines/toolbelt/custom.py:28) subclasses `Selector` (scrapling/parser.py:77), which
wraps a parsed `lxml.html.HtmlElement` in `_root`, deliberately *not* inheriting from lxml's element
class because lxml elements aren't pickleable (parser.py:112-114). Parsing is done by `lxml`
`HTMLParser` with `recover=True`, `remove_blank_text`, `huge_tree`, `default_doctype`, and configurable
comment/CDATA handling (parser.py:154-166); the result is parsed via `fromstring(body, parser=parser,
base_url=url)`. All querying is translated to XPath: CSS3 goes through a custom `cssselect.HTMLTranslator`
subclass (core/translator.py:122) with an `lru_cache(maxsize=256)` wrapper so `css()` runs `_css_to_xpath`
and then `xpath()` (parser.py:608-617) — the translator adds `::text` and `::attr(NAME)` pseudo-element
support matching the parsel/Scrapy selector format (translator.py:4-8, 91-119). `xpath()` executes
`root.xpath(selector, **kwargs)` with kwargs bound as XPath variables (parser.py:654, 671). Element
results are boxed into `Selector`/`Selectors` wrappers by `__element_convertor`/`__handle_elements`
(parser.py:219-261) that carry over `url`, `encoding`, adaptive flag and storage. `find_all`/`find`
(parser.py:709/807) build composite CSS attribute selectors (escaping via `_escape_css_string`,
parser.py:58) then layer regex and callable filters; similarly `find_by_text` (parser.py:1111) walks a
pre-compiled `.//*[normalize-space(text())]` node set and `find_by_regex` (parser.py:1177) does the
same with `TextHandler.re(... check_match=True)`. Text-centric output returns `TextHandler`
(a `str` subclass, core/custom_types.py:29) or `TextHandlers` (a `list` subclass,
custom_types.py:210) which carry `json()`, `re()/re_first()`, `clean()`, `get()` etc. The
`ResponseFactory` (engines/toolbelt/convertor.py:17) adapts heterogeneous sources — sync/async
Playwright responses and `curl_cffi` responses — into `Response`, including redirect-history folding,
content-type-charset extraction, and XHR capture. There is no parsel-style `.urls` convenience
method; URL extraction is composition (`css("a::attr(href)")`, `find_all("a")` + `urljoin`, or the
spider `links` crawler).

## Architecture / Call-Chain (text)

### Response object (HTTP metadata + tree wrapper)
- `Response` — engines/toolbelt/custom.py:28 — `class Response(Selector)`.
  - `__init__` encodes str content → utf-8 bytes (custom.py:57-58), pops `adaptive_domain` to seed the
    storage-pinned `url` (custom.py:60,69), stores `status/reason/cookies/headers/request_headers/history`,
    then `super().__init__(content=..., url=..., encoding=..., **selector_config)` — i.e. all parser
    kwargs are forwarded (custom.py:67-72).
  - Extra state: `meta` dict (validated), `request` (set by the spider crawler), `captured_xhr` list
    of nested `Response`s (custom.py:79-81).
  - `body` property — raw bytes of the original `_raw_body` (custom.py:83-86).
  - `markdown(css_selector, main_content_only)` — strips scripts/styles/prompt-injection noise then
    converts via `Convertor` (custom.py:88-102).
  - `follow(url, sid, callback, ...)` — spider helper returning a `Request` that reuses previous request's
    session kwargs/callback/priority/meta, setting `referer` (custom.py:104-160).
  - `__str__` → `"<status url>"` (custom.py:162).
- `BaseFetcher` — custom.py:166 — class-level parser configuration for all engines. Fields:
  `huge_tree`, `adaptive`, `storage`, `keep_cdata`, `storage_args`, `keep_comments`, `adaptive_domain`
  (custom.py:168-183). `configure(**kwargs)` mutates them (custom.py:210-227); `_generate_parser_arguments()`
  returns them for injection into every `Response` (custom.py:230-243).
- `StatusText` — custom.py:246 — MappingProxyType phrase table for HTTP status codes with an
  `lru_cache(maxsize=128)` `get()` (custom.py:319-322), used to fill `reason` when engines report empty text.

### The selector wrapper & DOM navigation
- `Selector(SelectorsGeneration)` — parser.py:77, `__slots__` at parser.py:78-91.
  - Constructor (parser.py:93-194): requires `content` or `root`; strips NUL bytes; empty string → `"<html/>"`;
    builds the `HTMLParser` kwargs (parser.py:154-164) and parses (parser.py:166); stores `_raw_body`.
    `adaptive=True` wires a storage system (default `SQLiteStorageSystem`, parser.py:104), validating that
    it's an `lru_cache`-wrapped `StorageSystemMixin` subclass (parser.py:188-194).
  - `__getitem__`/`__contains__` — attribute accessors `sel["href"]` (parser.py:196-204).
  - Lazy cached nodes props: `tag` (272), `text` (282), `attrib` (347), `html_content` (356), `body` (366),
    `prettify` (372) — computed on first access for init-time speed (parser.py:267-271 comment).
  - Tree navigation: `parent` (397), `below_elements` (403), `children` (411, ignores comments via
    `html_forbidden`), `siblings` (422), `iterancestors` (428), `find_ancestor` (435), `path` (446),
    `next`/`previous` (452/464, skipping `html_forbidden` comment nodes), `has_class` (387),
    `urljoin(relative)` (342).
  - `get_all_text(separator, strip, ignore_tags, valid_values)` (parser.py:292) — walks pre-compiled
    `.//text()` XPath, filters text nodes inside ignored tags (script/style) and whitespace-only strings.
  - Serialization: `get()`/`getall()` with `extract`/`extract_first` aliases (parser.py:475-489, 488-489).

### Querying backends
- **CSS3 → XPath translation** — core/translator.py.
  - `HTMLTranslator(TranslatorMixin, OriginalHTMLTranslator)` (translator.py:122) with
    `css_to_xpath(css, prefix="descendant-or-self::")` (translator.py:123).
  - Pseudo-elements: `XPathExpr` carries `textnode`/`attribute` flags (translator.py:20-51);
    `TranslatorMixin.xpath_pseudo_element` dispatches to `xpath_attr_functional_pseudo_element`
    (translator.py:110) and `xpath_text_simple_pseudo_element` (translator.py:117).
  - Module-level `css_to_xpath` cached with `lru_cache(maxsize=256)` (translator.py:131-134).
- `Selector.css(selector, identifier, adaptive, auto_save, percentage)` — parser.py:579.
  - Fast path: single selector → `_css_to_xpath` → `self.xpath(...)` (parser.py:607-617).
  - Combined `,` selectors are split via `cssselect.parse` and each canonical sub-selector saved under its
    own identifier (parser.py:619-632).
  - Syntax errors wrapped as `SelectorSyntaxError` (parser.py:633-637).
- `Selector.xpath(selector, identifier, adaptive, auto_save, percentage, **kwargs)` — parser.py:639.
  - `root.xpath(selector, **kwargs)` with kwargs as XPath variables (parser.py:671).
  - Direct hit → optional `save()` when `adaptive` + `auto_save` (parser.py:677); miss + adaptive →
    `retrieve()` + `relocate()` auto-heal (parser.py:680-688); guards warn when adaptive wasn't enabled
    (parser.py:690-697). Errors → `SelectorSyntaxError` (parser.py:701-707).
  - `relocate(element, percentage, selector_type)` (parser.py:530) scores every node via
    `__calculate_similarity_score` (parser.py:822) and `__calculate_dict_diff` (parser.py:890) — see
    adaptive report; `save`/`retrieve` at parser.py:896/917.
- `find_all(*args, **kwargs)` — parser.py:709. Accepts tag names, iterables of names, dicts of attributes,
  `re.Pattern`, and callables (validated, parser.py:732-761). `class_`→`class` and `for_`→`for` kwarg
  whitelist (parser.py:51-54). Builds `tag[attr="val"]` selectors with class multi-name `~=` expansion
  (parser.py:777-780, escaping via `_escape_css_string`), CSS-combines them, then applies regex +
  callable filters (parser.py:786-803). `find(...)` returns first or `None` (parser.py:807-820).
- `find_by_text(text, first_match, partial, case_sensitive, clean_match)` — parser.py:1111.
  Uses `_find_all_elements_with_spaces` (`.//*[normalize-space(text())]`, parser.py:71-73), normalizes case
  and whitespace, partial or exact match, short-circuits on first match (parser.py:1133-1156).
- `find_by_regex(query, first_match, case_sensitive, clean_match)` — parser.py:1177. Same node walk but
  filters on `TextHandler.re(... check_match=True)` (parser.py:1200).
- `find_similar(similarity_threshold, ignore_attributes, match_text)` — parser.py:1030.
  AutoScraper-style same-depth siblings via `//grandparent/parent/self[count(ancestor::*)=N]` XPath
  (parser.py:1076) filtered by `__are_alike` attribute scoring (parser.py:987).
- `Selectors(List[Selector])` — parser.py:1217. Broadcasts `xpath`/`css`/`re`/`re_first` to every element
  and flattens (parser.py:1239-1336); `search`/`filter` predicates (1338/1348); `get`/`getall`/
  `extract`/`extract_first` (1355-1374); `first`/`last`/`length` (1377-1389). Slices stay typed `Selectors`
  via `__getitem__` (parser.py:1224-1237). Pickle-guard `__getstate__` raises TypeError (parser.py:263/1391).
- Selector *generation* mixin — core/mixins.py:4 — `generate_css_selector` / `generate_full_css_selector` /
  `generate_xpath_selector` / `generate_full_xpath_selector` (mixins.py:64-90), class-less id-hinted path
  building that stops at `html` root.
- Back-compat aliases: `Adaptor = Selector`, `Adaptors = Selectors` (parser.py:1397-1398).

### ResponseFactory (engine adapters) — engines/toolbelt/convertor.py
- `from_playwright_response(page, first_response, final_response, parser_arguments, meta, xhr_captured, collect_history)`
  — convertor.py:83. Sync: falls back `final_response → first_response`; extracts charset from
  `content-type` via `__extract_browser_encoding` (convertor.py:29, 118); if `content-type` is html it
  uses the rendered `page.content()` (retry wrapper `_get_page_content`, convertor.py:200) re-encoded to
  utf-8 else the raw `final_response.body()` (convertor.py:124-128); cookies from `page.context.cookies()`;
  headers/request_headers from first_response; folds redirect history via `_process_response_history`
  (convertor.py:40) which walks `request.redirected_from` and inserts empty-content `Response`s
  (convertor.py:43-80). Nested XHR responses converted recursively into `response.captured_xhr`
  (convertor.py:148-152).
- `from_async_playwright_response(...)` — convertor.py:230. Same logic, awaited (`_async_process_response_history`
  at convertor.py:155, `_get_async_page_content` at convertor.py:215, captured XHR at convertor.py:296-300).
- `from_http_request(response: CurlResponse, parser_arguments, meta)` — convertor.py:303. Maps curl_cffi:
  `url`, `content`, `status_code`, `reason`, `encoding`, `cookies`, headers, request headers (with `method`),
  redirect `history`.
- `ResponseFactory` is wired into the engine layer: sync/async browser controllers call
  `from_playwright_response`/`from_async_playwright_response` (engines/_browsers/_controllers.py:184, 373);
  static fetchers use `from_http_request` via the sessions in engines/static.py.

### Fetcher entry points
- `Fetcher` / `AsyncFetcher` — fetchers/requests.py:28/48 — thin class-methods `get/post/put/delete` delegating
  (through `_merge_selector_config`, requests.py:17-25) to shared singletons `FetcherClient`/`AsyncFetcherClient`
  (requests.py:13-14, engines/static.py:771/781), which return `Response`.
- Browser fetchers: `DynamicFetcher` (fetchers/chrome.py:7) and `StealthyFetcher` (fetchers/stealth_chrome.py:7)
  share the `BaseFetcher` config class and return the `Response` built by the controllers' `ResponseFactory`.

## Convenience Methods / String & Attribute Handlers

- `TextHandler(str)` — core/custom_types.py:29 — strings stay typed (overrides `split/strip/upper/join/...`
  to return `TextHandler`/`TextHandlers`, custom_types.py:34-96); `sort` (100), `clean(remove_entities)` (104)
  collapses whitespace via the translation table + `__CONSECUTIVE_SPACES_REGEX__`; `get`/`getall`/
  `extract`/`extract_first` Scrapy-copy-paste aliases (112-119); `json()` via `orjson.loads` with a str()
  workaround for orjson's subclass bug (121-125); `re(...)` (148) compiling with `UNICODE|IGNORECASE`,
  optional `clean_match`, `check_match` boolean mode, flattening and `w3lib.replace_entities`;
  `re_first(...)` (184) returns first or default.
- `TextHandlers(List[TextHandler])` — custom_types.py:210 — `re`/`re_first` over the list (231/249),
  `get` (272), `extract` (278).
- `AttributesHandler(Mapping[str, TextHandler])` — custom_types.py:285 — dict-like attribute map whose
  values are `TextHandler`s; `search_values(keyword, partial)` generator (311), `json_string` property that
  orjson-encodes all attributes to bytes (324-327).
- `Selector.json()` — parser.py:932 — tries `_raw_body` (str or bytes) via `TextHandler.json()`, falls back to
  `.text` then `get_all_text(strip=True).clean()`.
- `Selector.re`/`re_first` — parser.py:948/964 — delegate to `self.text.re(...)`.
- `urljoin`/`url` — no standalone `.urls`; link extraction = CSS/XPath attribute query (`::attr(href)`) +
  `urljoin`, or spider `links` crawler (scrapling/spiders/links.py).

## Verified Source References (file:line)

- `Response` class & metadata — engines/toolbelt/custom.py:28, 57-81, 83-86, 88-102, 104-160, 162
- `BaseFetcher` config / `_generate_parser_arguments` — engines/toolbelt/custom.py:166, 168-183, 210-243
- `StatusText` phrase table — engines/toolbelt/custom.py:246, 319-322
- `Selector` class, `__slots__`, constructor, parse backend — scrapling/parser.py:77, 78-91, 93-194, 154-166
- element boxers / text-node detection — scrapling/parser.py:208-217, 219-261
- node properties & navigation — scrapling/parser.py:272-474
- `get_all_text` — scrapling/parser.py:292-340
- `get`/`getall`/`extract` aliases — scrapling/parser.py:475-489
- `css` — scrapling/parser.py:579-637
- `xpath` (+ kwargs vars, adaptive fallback) — scrapling/parser.py:639-707
- `relocate`/similarity — scrapling/parser.py:530-577, 822-894; `save`/`retrieve` 896-929
- `find_all`/`find` — scrapling/parser.py:709-820
- `find_by_text`/`find_by_regex` — scrapling/parser.py:1111-1214
- `find_similar`/`__are_alike` — scrapling/parser.py:1030-1089, 987-1028
- `Selectors` list subclass — scrapling/parser.py:1217-1393
- `Adaptor`/`Adaptors` aliases — scrapling/parser.py:1397-1398
- CSS translator + `::text`/`::attr()` pseudo-elements — scrapling/core/translator.py:20-51, 91-124, 131-134
- `SelectorsGeneration` mixin — scrapling/core/mixins.py:4-90
- `TextHandler`/`TextHandlers`/`AttributesHandler` — scrapling/core/custom_types.py:29, 210, 285 (json/re/clean: 104-207, 231-283, 311-327)
- `ResponseFactory` adapters — scrapling/engines/toolbelt/convertor.py:17, 29-37, 40-80, 83-152, 155-227, 230-300, 302-326
- Controller wiring — scrapling/engines/_browsers/_controllers.py:184, 373
- Fetcher entry points — scrapling/fetchers/requests.py:28-65, fetchers/chrome.py:7, fetchers/stealth_chrome.py:7