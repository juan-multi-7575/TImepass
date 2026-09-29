# Deep-Dig Report: Extraction Strategies Subsystem

**Repo:** crawl4ai (LLM-friendly web crawler)
**Feature:** Extraction strategies — `LLMExtractionStrategy`, `Json/CSS/XPath/regex` strategies, schema generation, chunking, and their integration into the crawl pipeline via the `extraction_strategy` param.

## One-Paragraph Summary

Crawl4AI turns an HTML page into **structured JSON** through an `ExtractionStrategy` abstraction, a chain of concrete strategies selected by the caller and invoked at the very end of `AsyncWebCrawler.arun()`. The pipeline is: fetched HTML is scraped/cleaned into `markdown`/`html`/`fit_html`, optionally chunked by a `ChunkingStrategy`, and then handed to a strategy whose `.run()/.arun()` returns a list of JSON dict blocks. Strategies fall into three families: **regex** (zero-LLM, pure-`re`, fastest), **selector-based JSON** (`JsonElementExtractionStrategy` + `JsonCss*`/`JsonXPath*`/`JsonLxml*` subclasses that walk a schema with CSS/XPath), and **semantic/LLM** (`CosineStrategy` for local embedding clustering; `LLMExtractionStrategy` for chat-LLM block/schema extraction with token accounting). LLM calls go through LiteLLM (`completion`/`acompletion`) wrapped by `perform_completion_with_backoff` (sync) / `aperform_completion_with_backoff` (async) in `utils.py`, driven by a `LLMConfig` (provider/api_token/backoff). The extracted list is JSON-serialized into `CrawlResult.extracted_content` and the LLM strategies additionally accumulate `TokenUsage` for `total_usage` / `show_usage()`.

## Architecture / Call-Chain (text diagram)

```
 user code
   │  CrawlerRunConfig(extraction_strategy=..., chunking_strategy=...)
   ▼
 AsyncWebCrawler.arun(url, config)
   │  (fetch + scroll + scrap → html / fit_html / markdown_result)
   ▼
 aprocess_html(...)
   │  guard: only if  extracted_content falsy
   │         AND config.extraction_strategy set
   │         AND NOT isinstance(strategy, NoExtractionStrategy)
   ├─ content = {markdown|html|fit_html|fit_markdown|cleaned_html}[strategy.input_format]
   ├─ chunking = IdentityChunking() if content is html-based else config.chunking_strategy
   ├─ sections = chunking.chunk(content)
   ▼
 strategy.arun(url, sections)      # async path (LLMExtractionStrategy has real async)
   └─ (fallback) asyncio.to_thread(strategy.run, url, sections)
        └─ class LLMExtractionStrategy.run  → merge_chunks(...token_threshold, overlap)
              → per-section extract(url, ix, html)   [groq path serial w/ 0.5s sleep;
                                                       others ThreadPoolExecutor(4)]
              → perform_completion_with_backoff(llm_config.provider, prompt, api_token, ...)
                   └─ litellm.completion / acompletion (utils.py:1742 / 1834)
           → parse <blocks> XML JSON or forced JSON → list[dict]
              → accumulate TokenUsage → total_usage / usages[]
   ▼
 extracted_content = json.dumps(blocks, indent=4, default=str, ensure_ascii=False)
   ▼
 CrawlResult(extracted_content=<JSON string>, ...)
```

## Key Files + Line References

### Strategy base & dispatcher — `extraction_strategy.py`
- `ExtractionStrategy(ABC)` **:86** — base; `input_format` ("markdown"|"html"|"fit_markdown"), `DEL`, `name`, `verbose`.
  - `extract()` abstract **:106**; `run()` parallel-ThreadPoolExecutor **:116**; `arun()` (async fallback via `asyncio.to_thread`) **:134**.
- `NoExtractionStrategy` **:149** — no-op, used as the "off" switch.
- `CosineStrategy` **:172** — BERT embeddings + hierarchical clustering (scipy) + text-multilabel nlp tags; uses `model_loader.load_HF_embedding_model`/`load_text_multilabel_classifier`; `extract()` **:440**, `run()` **:515** (joins sections with `DEL`).
- `LLMExtractionStrategy` **:533-1036** — the flagship LLM strategy.
  - `__init__` **:556** (llm_config, instruction, schema, extraction_type, chunking knobs, `force_json_response`, deprecation-guard props).
  - `__setattr__` **:630** — hard-rejects deprecated `provider`/`api_token`/`base_url`/`api_base` unless they equal the param default.
  - `extract()` **:641** — builds prompt (chooses among 4 prompt templates), calls `perform_completion_with_backoff`, records `TokenUsage`, parses `<blocks>` or JSON; error blocks carry `"error": True`.
  - `_merge()` **:774** → `utils.merge_chunks`; `run()` **:786** (sequential for `groq/*` with 0.5s delay, else max_workers=4 thread pool); `aextract()` **:843**; `arun()` **:972** (async `asyncio.gather`); `show_usage()` **:1020**.
- `JsonElementExtractionStrategy` **:1043** — abstract schema-driven extractor.
  - `extract()` **:1088** (baseSelector → rows → baseFields + fields); `_extract_field` **:1148**; `_extract_single_field` **:1178** (type pipeline text/attr/html/regex + transform); `_extract_item` **:1241**; `_apply_transform` **:1268**; `_compute_field` **:1293** (computed via `function` callable; `expression` disabled for security).
  - Schema validation/feedback: `_validate_schema` **:1366**, `_build_feedback_message` **:1498**, `_infer_target_json` **:1568**, `_extract_expected_fields` **:1618**, `_build_schema_prompt` **:1628**.
  - Schema generation: `generate_schema()` **:1692** (sync wrapper that spawns async) and `agenerate_schema()` **:1764** — fetch+concat HTML from URL(s) via a nested `AsyncWebCrawler`, preprocess HTML, then an LLM refinement loop (max 1+max_refinements) with strict/fuzzy validation against real HTML.
- Concrete JSON strategies:
  - `JsonCssExtractionStrategy` **:1989** (BeautifulSoup `lxml`) — `_resolve_source` walks a "+" sibling.
  - `JsonLxmlExtractionStrategy` **:2051** (lxml, `CSSSelector`→XPath, caching, many fallback selector strategies).
  - `JsonLxmlExtractionStrategy_naive` **:2337**.
  - `JsonXPathExtractionStrategy` **:2449** (lxml XPath, best-effort CSS→XPath).
- `RegexExtractionStrategy` **:2558** — zero-LLM extraction.
  - `_B` IntFlag catalog + friendly aliases **:2578-2631**; `DEFAULT_PATTERNS` regex dict **:2636**; `extract()` **:2713** (returns `{url,label,value,span}`); `generate_pattern()` **:2744** (LLM-assisted regex builder).

### Chunking — `chunking_strategy.py`
- `ChunkingStrategy(ABC)` **:8**; `IdentityChunking` **:28** (used for HTML input); `RegexChunking` **:38** (default; splits on `\n\n`); `NlpSentenceChunking` **:65** (NLTK sent_tokenize); `TopicSegmentationChunking` **:92** (TextTiling); `FixedLengthWordChunking` **:146**; `SlidingWindowChunking` **:174**; `OverlappingWindowChunking` **:214**.

### LLM I/O layer — `utils.py`
- `perform_completion_with_backoff` **:1742** and `aperform_completion_with_backoff` **:1822** — LiteLLM `completion`/`acompletion`, `litellm.drop_params=True`, temp 0.01, `response_format json_object` when requested, exponential backoff on `RateLimitError` only.
- `merge_chunks` **:162** / `chunk_documents` **:76` — token-budgeted merging with overlap; `CHUNK_TOKEN_THRESHOLD`/`OVERLAP_RATE`/`WORD_TOKEN_RATE` feed these.
- `preprocess_html_for_schema` **:3084**, `sanitize_html`/`escape_json_string`/`sanitize_input_encode`/`split_and_parse_json_objects`/`extract_xml_data` (around **:707/752/795/809/1680**).

### Config — `async_configs.py` & `config.py`
- `CrawlerRunConfig` `extraction_strategy` **:1590**, `chunking_strategy` **:1591 (default `RegexChunking()`); type-check validation **:1838-1848**; default chunking fallback **:1865**.
- `LLMConfig` **:2216** — provider `"openai/gpt-4o"` default, api_token resolution (env, `env:` prefix, `PROVIDER_MODELS_PREFIXES`), backoff params; untrusted-provenance guard **:2242**.
- `config.py`: `DEFAULT_PROVIDER` **:7**, `CHUNK_TOKEN_THRESHOLD` **:43 (2048)**, `OVERLAP_RATE` **:44 (0.1)**, `WORD_TOKEN_RATE` **:45 (1.3)**, `HTML_EXAMPLE_DELIMITER` **:107**.

### Pipeline wiring — `async_webcrawler.py`
- `aprocess_html` **:715**; extraction block **:895-945** — this is the single consumer in the main crawler.

### Models — `models.py`
- `TokenUsage` **:88**, `CrawlResult.extracted_content` **:143** (JSON string).

### Prompts — `prompts.py`
- `PROMPT_EXTRACT_BLOCKS` **:1** (XML `<blocks>` wrapper), `..._WITH_INSTRUCTION` **:51`, `PROMPT_EXTRACT_SCHEMA_WITH_INSTRUCTION` **:108`, `..._INFERRED_SCHEMA` **:145`, `JSON_SCHEMA_BUILDER` **:248` and `JSON_SCHEMA_BUILDER_XPATH` **:712`.

### Exports
- `__init__.py` **:22-31** re-exports `ExtractionStrategy`, `LLMExtractionStrategy`, `CosineStrategy`, `JsonCss`, `JsonXPath`, `JsonLxml`, `RegexExtractionStrategy`, `ChunkingStrategy`, `RegexChunking`. `cli.py` builds strategies at **:1122** (LLM), **:1159** (json-css), **:1163** (json-xpath).

## Connections Map (inbound / outbound)

**Inbound (who feeds it):**
- `AsyncWebCrawler.arun/arun_many/aprocess_html` — the only crawler entry point that invokes `extraction_strategy` (`.run/.arun`).
- `AsyncWebCrawler` scraping layer supplies the input content (`markdown_result.raw_markdown`, `clean content_by content_format`, `fit_html`, `cleaned_html`) at async_webcrawler.py:913-919.
- `markdown_generation_strategy`/`content_filter_strategy` produce `markdown_result` (raw/fit) which `fit_markdown`-based strategies consume.
- `chunking_strategy` module feeds sections into `run()/arun()`.
- `cli.py` and `generate_schema` (which spawns its own nested `AsyncWebCrawler` to fetch URLs, async_configs import at extraction_strategy.py:1827-1867) are the programmatic + CLI entry points for constructing strategies.
- `config` (defaults), `types` (`create_llm_config` → `LLMConfig`), `utils`, `prompts`, `model_loader` (Cosine).

**Outbound (what it affects):**
- Any code reading `CrawlResult.extracted_content` (JSON blob) gets structured data.
- `TokenUsage` accumulation surfaces via `LLMExtractionStrategy.show_usage()` / `total_usage`.
- `JsonElementExtractionStrategy.generate_schema()` returns a schema dict ready for `JsonCss*`/`JsonXPath*` — a schema-generation ↔ schema-consumption loop.
- Browser fetches are triggered inside schema generation (nested crawler), affecting crawl depth/rate.

## Impact Analysis

- **Primary output channel** for "give me structured JSON" — all other scraped artifacts (markdown, html, links, media) are side effects; `extracted_content` is the payload most consumers actually want.
- **Cost/latency exposure** — `LLMExtractionStrategy` makes emergent LLM calls per merged chunk; chunk params (`chunk_token_threshold`, `overlap_rate`, `word_token_rate`, `force_json`, `extraction_type`) directly control token cost and call count.
- **Throughput coupling** — `groq/*` extraction is forced sequential with 0.5s sleeps; all other providers go 4-way thread pool; `arun` uses `asyncio.gather` (unbounded concurrency across all merged sections — a rate-limiter footgun).
- **Data-flow coupling** — since extraction consumes `input_format` (default `"markdown"`), the markdown/content-filter stage must have run first; `fit_markdown` falls back to `markdown` when empty (async_webcrawler.py:903-911), matching the known fit_markdown-empty quirk.
- **End-to-end data flow**: html → (render → clean by scrape) → markdown/html → chunk (chunking_strategy) → sections → `extract()/run()/arun()` → strategy-specific → list[dict] → `json.dumps` → `CrawlResult.extracted_content`.

## Gotchas & Quirks

1. **`extract()` signatures diverge** — `ExtractionStrategy.extract(url, html, *q)` vs `LLMExtractionStrategy.extract(url, ix, html)` (extraction_strategy.py:106 vs 641). The base `run` (extraction_strategy.py:116) calls `self.extract(url, section)`; the LLM override never uses the base `run`. Mixing a doubled subclass into a generic caller will mis-bind `ix`.
2. **Deprecation gate uses `is not default`** — `__setattr__` (extraction_strategy.py:636) compares `value is not all_params[name].default`; because string identity (not equality) is checked, an equal-but-not-identical string may or may not raise depending on interning. Fragile.
3. **`NoExtractionStrategy` short-circuit** — the `isinstance` check on line 898 means a strategy explicitly set to `NoExtractionStrategy` is skipped entirely; setting no strategy also skips.
4. **JSON type coercion** — when `force_json_response=True`, a single flat object is wrapped `[blocks]`; a single-key dict whose value is a list is unwrapped (extraction_strategy.py:726-733). Behaviour is easy to get wrong on a schema whose root is `{"items": [...]}`.
5. **`expression` computed fields are hard-disabled** (eval on untrusted input) while `function` callables are allowed — a deliberate security decision, not a bug.
6. **Regex backslash sanitization** — `_sanitize_schema` and `generate_pattern` pre-fix lone-backslash/backspace patterns and require doubled backslashes from the LLM (extraction_strategy.py:1790-1830, 2666-2672). Slippery when hand-writing regexes.
7. **`JsonXPath._get_elements` scoping** — CSS→XPath prepends `.`/`//`; a full `/`-rooted XPath in `_css_to_xpath` is passed verbatim but `_get_elements` may mis-scope relative to the caller's context.
8. **HTML-input chunking forced to IdentityChunking** (async_webcrawler.py:922-926) — CSS/XPath/regex strategies get a single section regardless of `config.chunking_strategy`.
9. **Chunking `merge_chunks` target_size token notion** is an estimate (`len(words) * word_token_rate`), so effective chunk sizes drift from true model tokens.
10. **Unbounded async concurrency in `arun`** — every merged section becomes a concurrent `aperform_completion`; on long pages this floods the provider and can trip rate limits (only mitigated in the *sync* `run`'s groq branch).