# Deep-Dig Checklist: crawl4ai

Subagents MUST append one line per dig here (do not overwrite others lines, only append).
Format: `- [x] <agent-name> | <feature> | <files dug> | <one-line finding>`

- [x] agent-markdown-filters | markdown generation + content filtering (Pruning/BM25/LLM, raw vs fit, citations) | markdown_generation_strategy.py, content_filter_strategy.py, async_webcrawler.py, models.py, html2text/__init__.py | fit_markdown is empty unless a content filter is configured, so downstream consumers must fall back to raw_markdown.
- [x] agent-crawler-pipeline | core AsyncWebCrawler arun() pipeline (URL → fetch/wait/render → scrape → markdown → extract → CrawlResult) incl. deep crawling | async_webcrawler.py, async_crawler_strategy.py, deep_crawling/base_strategy.py + bfs_strategy.py, models.py, async_logger.py, cache_context.py, content_scraping_strategy.py, markdown_generation_strategy.py | arun() is a single funnel router: DeepCrawlDecorator + cache/anti-bot layers all re-enter the same arun(), which returns CrawlResultContainer whose .markdown is a StringCompatibleMarkdown (str subclass) for backward compat.
- [x] agent-extraction | extraction strategies (LLM/Json-CSS-XPath-Lxml/Regex/Cosine + schema gen + chunking) | extraction_strategy.py, chunking_strategy.py, utils.py, async_webcrawler.py, async_configs.py, models.py, prompts.py | extraction is a single consumer stage driven by strategy.input_format; LLM strategies gate their deprecated-param redesign and are skipped if `NoExtractionStrategy` or a pre-set extracted_content.
