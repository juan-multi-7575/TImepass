# Deep-Dig Report: Markdown Generation + Content Filtering Subsystem (crawl4ai)

## Feature name
**Markdown generation & content filtering** — `MarkdownGenerationStrategy` (DefaultMarkdownGenerator), `PruningContentFilter`, `BM25ContentFilter`, `LLMContentFilter`, relevant-content scoring, and the raw-HTML → raw/fit markdown pipeline with citation conversion.

## One-paragraph summary
This subsystem is the last HTML→text stage of a crawl. The crawler first runs a **scraping strategy** (`LXMLWebScrapingStrategy`) that produces `cleaned_html`, then the `DefaultMarkdownGenerator` converts that (or optionally `raw_html` / `fit_html`) into **raw markdown** via the vendored `CustomHTML2Text`, optionally rewrites inline links into numbered `⟨N⟩` **citations** plus a `## References` footer, and — only when a `RelevantContentFilter` (Pruning or BM25) is configured — produces a separate **fit_markdown / fit_html** by scoring/selecting a subset of page blocks and re-rendering them. The result is a `MarkdownGenerationResult` (raw_markdown, markdown_with_citations, references_markdown, fit_markdown, fit_html) stored on `CrawlResult.markdown`. Downstream, LLM extraction strategies and the adaptive crawler consume it, so this subsystem largely determines what an LLM ultimately sees.

## Architecture / call-chain (text diagram)

```
raw HTML ──────────────────────────────────────────────────────┐
   │ browser fetch / raw: input                                │
   ▼                                                           │
LXMLWebScrapingStrategy.scrap()  [content_scraping_strategy.py:122]
   └─► cleaned_html (sanitized) ────────────────┐               │
                                               ▼               │
                    aprocess_html() [async_webcrawler.py:715]
       preprocess_html_for_schema(html) [utils.py:3084] ──► fit_html
       content_source selector {raw_html|cleaned_html|fit_html}
                            [async_webcrawler.py:830-858]
                                     ▼
        DefaultMarkdownGenerator.generate_markdown()  [markdown_generation_strategy.py:148]
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼ raw path                    │ filtered path (if filter)  │
   CustomHTML2Text.handle(input)      ▼                             │
   [html2text/__init__.py:153/1070]  content_filter.filter_content(input_html)
        ▼                            [content_filter_strategy.py]   │
   raw_markdown                      ┌────────────┼────────────┐   │
        │                       PruningContentFilter   BM25ContentFilter  LLMContentFilter
        ▼                             (fold/DOM prune)  (BM25Okapi score)  (LLM calls)
   convert_links_to_citations()  [line 82]              │                │
        │                        each filter returns List[str] of cleaned block HTML
        ▼                            └────────────┼────────────┘
   markdown_with_citations                       ▼
        + references_markdown            "\n".join(<div>{block}</div>)
                                              └─► CustomHTML2Text.handle ─► fit_markdown
        └──────────────── MarkdownGenerationResult ────────────────┘
                             [models.py:120]
                                 ▼
                         CrawlResult.markdown  [models.py:143/189]
                                 ▼
   extraction_strategy.run() [async_webcrawler.py:913]  ──► extracted_content (JSON)
   adaptive_crawler / CLU consume result.markdown.raw_markdown
```

## Key files & line references (verified)

### Markdown engine
- `crawl4ai/markdown_generation_strategy.py`
  - `LINK_PATTERN` regex for link/citation detection — line 11
  - `fast_urljoin()` — line 14
  - `MarkdownGenerationStrategy` (ABC) — line 26; abstract `generate_markdown` — 42
  - `DefaultMarkdownGenerator.__init__` — 74
  - `convert_links_to_citations()` → `(converted_text, references)` — 82–146
  - `generate_markdown()` — 148; html2text options — 181–199; raw md via `h.handle` — 210; citation pass — 219–227; filter→fit path — 229–242; returns `MarkdownGenerationResult` — 244

### HTML → Markdown converter
- `crawl4ai/html2text/__init__.py`
  - `HTML2Text.handle()` — 153
  - `CustomHTML2Text` — 1070; `update_params` — 1096; `handle_tag` (pre/code/link/preserve) — 1106; `handle_data` — 1179

### Content filters (scoring core)
- `crawl4ai/content_filter_strategy.py`
  - `RelevantContentFilter` (ABC) — 33; `extract_page_query()` (title/h1/meta/1st-para fallback) — 125; `extract_text_chunks()` (deque walk, header-vs-content tagging) — 161; `is_excluded()` — 320; `clean_element()` (string-builder HTML re-render) — 329
  - `BM25ContentFilter` — 381; `__init__` (threshold, stemming, priority_tags weights: h1=5.0 … th=1.5) — 403–438; `filter_content()` — 440 (tokenize → stem → `clean_tokens` → `BM25Okapi.get_scores` → tag-weighted → threshold → doc-order sort → dedupe → `clean_element`)
  - `PruningContentFilter` — 541; `filter_content()` (comment/unwanted removal, `_prune_tree`, block extraction) — 640; `_remove_comments` — 680; `_remove_unwanted_tags` — 685; `_is_preserved` — 691; `_prune_tree()` — 701; `_compute_composite_score()` (5 weighted metrics + `min_word_threshold` short-circuit) — 757; `_compute_class_id_weight()` — 794
  - `LLMContentFilter` — 808; `filter_content()` (cache, `merge_chunks`, ThreadPool 4-workers, `perform_completion_with_backoff`, xml extraction) — 921; cache key md5 — 905; chunk splitting via `_merge_chunks`/`merge_chunks` — 910

### Data model / serialization
- `crawl4ai/models.py`
  - `MarkdownGenerationResult` — 120 (raw_markdown, markdown_with_citations, references_markdown, fit_markdown, fit_html)
  - `CrawlResult._markdown` PrivateAttr — 143; `markdown` property → `StringCompatibleMarkdown` — 189–199; deprecated `markdown_v2` — 209; deprecated `fit_markdown`/`fit_html` — 228/238; `model_dump` override — 247; `StringCompatibleMarkdown` — 277

### Orchestration
- `crawl4ai/async_webcrawler.py`
  - `aprocess_html()` — 376; scraping strategy exec — 783; `pre_html_for_schema` → fit_html — 416; `generate_markdown` call — 471–477; HTML-source dispatch — 421–458; extraction content pick (raw_markdown / fit_markdown / fit_html) — 913–919; result assembly — 956
- `crawl4ai/async_configs.py` — `markdown_generator` config field — 992; validation (must be `MarkdownGenerationStrategy`, dict→instantiation hint) — 150–155
- `crawl4ai/utils.py` — `clean_tokens()` (stopword/noise removal for BM25) — 2565; `preprocess_html_for_schema()` (fit_html producer: strips head/scripts/attrs, truncates text) — 3084
- `crawl4ai/cli.py` — wiring filters from config: `BM25ContentFilter`/`PruningContentFilter` → `DefaultMarkdownGenerator` — 688–701

### Downstream consumers
- `crawl4ai/extraction_strategy.py` — `input_format` incl. `fit_markdown` — 97, 589
- `crawl4ai/adaptive_crawler.py` — consumes `result.markdown.raw_markdown` (lines 119, 556, 611, 1242, 1544, 1777, 1821)

## Connections map

**Inbound (who feeds this subsystem):**
- `content_scraping_strategy.py:122` — `LXMLWebScrapingStrategy` produces `cleaned_html` (the default `content_source`)
- `async_webcrawler.py:376` — raw captured HTML + `fit_html` via `preprocess_html_for_schema`
- `async_configs.py` — the `markdown_generator` instance (user-injected filter / options)
- `cli.py` — CLI argument → filter config → generator construction

**Outbound (what it feeds):**
- `CrawlResult.markdown` (models.py) → the primary `LLMExtractionStrategy`, `JsonCssExtraction` (`input_format="fit_markdown"`), `adaptive_crawler` knowledge-base content, `async_database.py` persistence, and end-user code
- `fit_html` also feeds schema/preview consumers; `fit_markdown` gates LLM token budgets
- Standalone legacy helpers `get_content_of_website_*` reuse the same html→markdown path (`utils.py:1108-1131`)

**AFFECTS the rest of the system:**
- LLM extraction quality is bounded by the filter: without a filter the LLM sees full raw markdown (huge token cost); with Pruning/BM25 it only sees "relevant" blocks — compressing tokens but risking info-loss when the filter culls content the schema needed.
- Citations add an explicit `⟨N⟩ url — title` reference footer, letting an LLM trace claims to sources without leaking full link syntax into body text.
- Output is now an object not a string; legacy `markdown_v2`/`fit_markdown` attribute accesses throw `AttributeError` (models.py:372), so every consumer must use `.markdown.<property>`.

## Gotchas / quirks found
1. **Pruning threshold is opaque.** `_compute_composite_score` returns a weighted-average of density metrics, but fixed default 0.48 and the `min_word_threshold` short-circuit (`return -1.0`, line 764) mean behavior changes sharply with token count. It is not a probability/"relevant" score despite the docstring.
2. **Pruning extracts child blocks, not a scored filter.** After `_prune_tree` runs, `filter_content` returns `str(element)` of direct children (`html/…`, lines 672-675) — i.e. it keeps the *surviving DOM* re-serialized, so fit_markdown is the surviving subtree converted, unlike BM25 which re-renders only kept text blocks.
3. **BM25 needs a query; falls back to page metadata / first long paragraph** (`extract_page_content`, line 125). If no query and no metadata → `filter_content` returns `[]` (lines 466-470) → fit becomes empty.
4. **Chemically: sharp fallbacks.** No filter → `fit_markdown`/`fit_html` are empty strings, NOT raw. Anything depending on fit must check for empty (async_webcrawler.py:903 falls back to `markdown`).
5. **`content_source` is a config-time selector** (raw_html/cleaned_html/fit_html) that changes the *input* to whichever single markdown generator — the filter always receives this same input HTML (md_gen.py:235), a filter same-HTML mismatch foot-gun when source != cleaned.
6. **Two different HTML→md converters exist**: the strategy uses `html2text/…:1070` directly with `ignore_links=False` (links kept for citations), while legacy helpers and `_scrap_html`-style paths use `CustomHTML2Text()` with `ignore_links=True` (utils.py:1115). Citation output is therefore only produced by the main generator path.
7. **Citations use the `⟨⟩` Unicode char** (or the conservative regex `LINK_PATTERN`), which is uncommon in markdown renderers — it's a crawl4ai-specific syntax LLM tooling must learn; references block is emitted as `## References` only when `citations=True` (default).
8. **LLMContentFilter caches to `~/llm_cache/content_filter` (keyed by md5 of html+instruction)**; but `filter_content` forces `ignore_cache = self.ignore_cache` (line 940), so the cache is bypassed unless the user constructs it with `ignore_cache` left falsy.

9. **Output is now an object, not a string** — legacy `markdown_v2` (models.py:209) and `CrawlResult.fit_markdown`/`fit_html` (models.py:228/238) attribute accesses throw `AttributeError`, so every consumer must use `.markdown.<property>`.
10. **BM25 priority_tag weight is raw-tag-based** (`priority_tags[tag.name]`, line 513), multiplying the BM25 term score; it does not run its own tag pass — misleading docstring says "sort by score desc" but it actually re-sorts to original doc order (line 528) for stable output.
11. **Backward-compat shim:** `CrawlResult.markdown` is a `StringCompatibleMarkdown(str)` subclass — comparing it as a string yields `raw_markdown`, but `model_dump` is overridden (models.py:247-273) to include the full object, so the serialized shape differs between the two representations.