# Scrapling — Adaptive / Auto-Heal Element Selection

## Feature
Adaptive / auto-heal element selection — Scrapling's signature self-healing lookup where selectors
(and their results) persist as *fingerprints* so that, when a page's DOM changes and a CSS/XPath
selector returns nothing, Scrapling re-locates the previously-targeted element by content similarity
instead of failing. Includes the sibling feature `find_similar()` (AutoScraper-style "find other
products like this one") and the storage layer that fingerprinted elements are persisted in.

## One-Paragraph Summary

Adaptive selection works as a **save → retrieve → relocate** cycle guarded by a per-instance flag.
A `Selector` instance created with `adaptive=True` and a storage system will let `css()` / `xpath()`
(and thus `find`/`find_all`) *save* the fingerprint of matched element(s) under a stable `identifier`
(defaults to the selector string). On a later page / a fresh DOM where the raw selector matches
nothing, the call transparently falls back to *retrieve*-ing the saved fingerprint from storage and
handing it to `relocate()`, which scores **every node in the tree** against that fingerprint and
returns the best node(s) above a `percentage` threshold. Fingerprints are cheap structural dicts
(tag, cleaned attributes, text, a full root-to-node tag path, plus parent/sibling/children tags)
built by `_StorageTools.element_to_dict`, persisted as JSON in a domain-scoped SQLite table.
Similarity is a weighted average of `difflib.SequenceMatcher` ratios over tag, text, attribute
keys/values, key attributes (`class`/`id`/`href`/`src`), node path, and parent descriptors.
`find_similar()` is a lightweight sibling view: it finds same-depth, tag-chain-matching candidates
via one XPath and filters them with a per-attribute threshold, never touching storage.

## Architecture / Call-Chain (text)

- Fetchers/engines produce a `Response` object
  - engines/toolbelt/custom.py:28  `class Response(Selector)` — writes real URL, but seeds
    `url=` with `adaptive_domain` when given (custom.py:60,69) so the *storage* is domain-pinned.
  - engines/toolbelt/convertor.py:17 `ResponseFactory.from_http_request(...)` builds it
    (static.py:259), forwarding `selector_config = {adaptive, storage, storage_args, adaptive_domain, ...}`.
- User calls `page.css("#p", adaptive=True)` or `page.find_all(...)` / `find(...)`:
  - `Selector.css` (parser.py:608) — splits on a top-level `,` prefix so each sub-selector saves under
    its own canonical selector (auto-reselect-save helper); otherwise single call.
  - delegates to `Selector.xpath` (parser.py:670).
- `xpath` flow (parser.py:671–699):
  1. `elements = root.xpath(sel)` (direct match)
  2. if elements and `auto_save` → `self.save(elements[0], id)` (parser.py:677) — persists fingerprint
  3. if **no** elements and adaptive-enable head → `self.retrieve(id)` then `self.relocate()` (680–684)
  4. if still nothing → auto-heal via re-locate, done.
- `relocate()` (parser.py:530):
  - `element_to_dict` (via `_StorageTools`) if given a live DOM node
  - loops `_find_all_elements(self._root)` — `.//*` (parser.py:70, 553) — scoring each node
    against the fingerprint via `__calculate_similarity_score` (parser.py:557)
  - buckets nodes by score in a `score_table` dict; returns the highest-scoring bucket **above**
    the `percentage` threshold (parser.py:560-577); logs top-5 at debug.
- `__calculate_similarity_score` (parser.py:822): weighted average of per-field ratios
  (see Similarity section); helper `__calculate_dict_diff` (parser.py:890) compares attribute
  dicts via key-tuple + value-tuple `SequenceMatcher`.
- `save`/`retrieve` (parser.py:896/917) → `self._storage.save/retrieve(id)`.
- `SQLiteStorageSystem` (storage.py:74): `element_to_dict` → orjson `dumps` into a
  `storage` table keyed by `(url_domain, identifier)`; `url` = `StorageSystemMixin._get_base_url`
  (tld-extracted domain, storage.py:23).
- `find_similar` (parser.py:1030): computes current depth + 3-level tag chain (`grandparent/parent/self`),
  XPath `//a/b/c[count(ancestor::*) = N]` (parser.py:1076), filters each non-root candidate via
  `__are_alike` (parser.py:987) threshold — never touches storage.

```
fetch -> Response(Selector)         [custom.py:28, convertor.py:17, static.py:259]
          + url <- adaptive_domain (storage key)
Selectors.css()                     parser.py:607
  -> split on ','  (per-selector ids)
Selectors.xpath()   parser.py:670
  -> root.xpath() hit?  YES -> auto_save[elements[0], id] (677)
                        NO  (and adaptive) -> retrieve(id) (682)
                                                                  +-> _storage(retrieve)
                        -> relocate(elem_data) parser.py:530              |
  relocate: element_to_dict -> for node in //*: score            <---- Element dict
            select best > percentage (571)
  find_similar() (no storage): XPath depth/chain + attribute threshold (1030)

Storage layer:  SQLiteStorageSystem (core/storage.py:74)
  _get_base_url = tld domain                     storage.py:26
  save/retrieve via _StorageTools.element_to_dict, orjson
  element_to_dict/auth path: core/utils/_utils.py:84, _get_element_path:112

Thumbprint source:  _StorageTools.element_to_dict  _utils.py:84
Similarity engine:  difflib.SequenceMatcher + __calculate_dict_diff parser.py:822,890
```

## Key Files & Line References

- `scrapling/parser.py`
  - class attribute `__slots__ __adaptive_enabled`, `_storage` (parser.py:81,83)
  - `__init__` adaptive + storage bootstrap (parser.py:102-105,144,176-194)
  - `__element_convertor` / seeds nested Selectors w/ storage+flag (parser.py:219-230,232-254)
  - `css` comma-split & delegation (parser.py:583-632)
  - `xpath` with save/adapt/`auto_save` logic (parser.py:639-707); auto_save save `elements[0]` (677); retrieve+relocate fallback (680-688)
  - `relocate` full-tree scoring (parser.py:530-578)
  - `find_all` / `find` (parser.py:709-820, find 811)
  - `__calculate_similarity_score` (parser.py:822-887)
  - `__calculate_dict_diff` (parser.py:890-894)
  - `save`/`retrieve` (parser.py:896-930)
  - `__are_alike` (parser.py:987-1028), `find_similar` (parser.py:1030-1089)
- `scrapling/core/storage.py`
  - `StorageSystemMixin`, `get_base_url` via `tld` (storage.py:14-71)
  - `_get_hash` (storage.py:63) — unused by SQLite impl
  - `SQLiteStorageSystem` `(lru_cache(1,typed=True)` class) (storage.py:73-159)
  - `_setup_database` table (storage.py:97-107), `save` (109), `retrieve` (128), `close` (146)
- `scrapling/core/utils/_utils.py`
  - `_StorageTools.element_to_dict` fingerprint (utils.py:84-109)
  - `_get_element_path` root path tuple (utils.py:112-114), `__clean_attributes` (78)
- `scrapling/engines/toolbelt/custom.py` — `Response(Selector)` (28), `adaptive_domain` pin (60,69), ResponseConfig class fields+plumbing (169-240)
- `scrapling/engines/toolbelt/convertor.py` — `ResponseFactory` (17, from_http_request builds Response)
- `scrapling/engines/static.py` — `_make_request` passes `selector_config` (224-259)
- `scrapling/integrations/scrapy.py` — `scrapling_response(adaptive=True)` decorator (72), forwards selector_config (31,78)

## Connections Map

**Inbound (who feeds adaptive):**
- Fetchers/engines → `Response` → `Selector` constructor. `adaptive`, `storage`, `storage_args`, `adaptive_domain` are config forwarded by `ResponseFactory` (convertor.py) and `@scrapling_response` (scrapy.py). No engine itself drives adaptive; it's config-only.
- Parser internals: any `css`/`xpath` call; `find_all`/`find` funnel to `css`.

**Outbound (adaptive → the rest):**
- Storage (`SQLiteStorageSystem`) — write/read fingerprints, domain-scoped.
- `_StorageTools.element_to_dict` — the fingerprint contract used by both the parser and storage.
- `lxml` (`_find_all_elements` XPath `.//*`, `HtmlElement`), `difflib.SequenceMatcher`, `cssselect`, `orjson`, `tld` (domain keying).
- Nested `Selector`s inherit `_storage`/flag (element_convertor), so once adaptive is on it propagates down the whole result tree without reconf.

## Impact Analysis

- **Reliability**: A selector that returns nothing no longer ⇒ broken scrapes. `xpath` marks the page as "changed" and recovers the target fingerprint (parser.py:680). This is the core value prop: resilience to non-breaking site DOM churn (attribute renames, interment wrappers, class reorder).
- **Cost — brute-force relocate**: `relocate` is O(N) over the entire tree, and in `find_similar` even a normal `xpath` path scanning every node whenever a single selector misses. For large documents this is the dominant adaptive cost. Docs/lint warn that `percentage` is structural-only.
- **State persistence**: every saved fingerprint persists on disk (a `elements_storage.db` next to the module — parser.py:47). Identifiers double as dedup keys `(url, identifier)` unique — re-saving `INSERT OR REPLACE`s the row (storage.py:121). Shared `lru_cache` class = a single SQLite connection shared thread-safely (RLock, WAL, check_same_thread=False).
- **Multi-tenant**: storage is keyed by the **registered domain** from `tld` (storage.py:37) so same-domain pages share, different domains are isolated — even across different page URLs on the same site.
- **Integration surface**: `adaptive` + `adaptive_domain` exposed to Scrapy via `@scrapling_response(adaptive=True)` — means adaptive behavior follows across framework boundaries.

## Gotchas / Quirks

1. **Relocation only fires on a selector miss.** In `xpath` (parser.py:680) the adaptive fallback lives in the `elif` branch that runs only when the xpath was empty — a selector that still matches (maybe wrongly) never triggers relocate.
2. **Full-tree scan, always:** `relocate` scores every element, never stops at 100% (parser.py:553) — intentional (there may be multiple equal matches) but O(N) on every auto-heal.
3. **"score = weighted mean of applied *checks*"**: the fingerprint dict is sparse — text/parent/sibling checks are only counted if non-empty in the *original* (`if original["text"]` at parser.py:836, `if original.get("parent_name")`:862, `if original.get("siblings")`:882). Two fingerprints scoring different check-counts produce different scale for same threshold; a text-less element gets a "cleaner" (higher) percentage than a text-full one.
4. **`element_to_dict`.`path` is root→leaf of tags only (no indices/classes)** (utils.py:112). Two different subtrees with identical tag structure look identical on that axis — the tag-path similarity only helps when structure differs.
5. **`parent_attribs` compared raw** in `__calculate_similarity_score` (not cleaned like the node's own attributes), and it has a **commented-out penalty** (`# score -= 0.1` at parser.py:878-880) for "original has parent but candidate does" — the penal the never landed, so that case is just silently not counted.
6. **Percent rounding**: score rounded to 2 decimals (parser.py:887) then compared against integer `percentage`; borderline thresholds can be unexpectedly pass/fail at the 0.x boundary.
7. **`auto_save` saves only `elements[0]`** (parser.py:677,686) — multi-match selectors persist just the first node as `id` fingerprint.
8. **`find_similar` is coarse at depth:** it builds a path from only **grandparent+parent+self** and anchors with `//` (parser.py:1069-1076), so candidates are same-tag/same-depth anywhere in the doc — intermediate/ancestry differences are not checked and rely on `__are_alike` scoring, which uses `max(len, len)` denominator totaling extra attributes (in-flated → avoids in-lining; parser.py:1009-1011).
9. **Text-node roots abort adaptive**: `Selector._is_text_node(root)` sets `__adaptive_enabled=False` (parser.py:172-174), so text/xpath result leaf nodes effectively cannot adapt.
10. **`auto_save` silently ignored** when adaptive disabled globally (parser.py:672) — warns, doesn't save; the adaptive flag itself can't override the instance-level `adaptive=`.
11. **Storage reconnect/quirk**: the storage class must be lru(ns:...)-decorated else `Request` values `ValueError: Storage class must be wrapped with lru_cache ...` (parser.py:188-191); `identifier` is stored raw (`_get_hash` exists but unused — SQLite uses the plain `identifier` column).
12. **`css()` comma-splitting** exists so combined selectors save under each canonical selector (parser.py:620-630); connectives change the save key.
13. **Cross-page identity** assumes *same domain* for retrieval (via `_get_base_url`); changing `adaptive_domain` between requests silent-shifts the storage partition.

## Verification

- All file:line refs verified by reading the target files in this repo (parser.py, storage.py, _utils.py, custom.py, convertor.py, static.py, scrapy.py).
- Behavior cross-checks: tests/parser/test_adaptive.py (relocation, auto_save threshold test at 59-83), test_find_similar_advanced.py.