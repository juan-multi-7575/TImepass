# Deep-Dig Report: DOM / Element Service (browser-use)

## Feature name
DOM serialization to the LLM-facing page representation — the pipeline that turns a live Chromium page into the indented `[index]<tag attr=... />` text the model sees, decides which elements are clickable/visible, and maps the numeric indices the model outputs back onto real DOM nodes for action execution.

## One-paragraph summary
When the agent needs the current page, `BrowserSession.get_browser_state_summary` fires a `BrowserStateRequestEvent`; the `DOMWatchdog` handler answers it by calling `DomService.get_serialized_dom_tree` (dom/service.py:1097). That service first gathers four things from CDP in parallel (a `DOMSnapshot.captureSnapshot`, a `DOM.getDocument`, a merged cross-frame accessibility tree, and the device-pixel-ratio, plus two JS evaluations for iframe scroll offsets and JS `click`-listener detection) and folds them into one `EnhancedDOMTreeNode` tree keyed by CDP `backendNodeId`. `DOMTreeSerializer.serialize_accessible_elements` then converts that tree into a `SimplifiedNode` tree, applies paint-order and bounding-box containment filtering, decides interactivity via `ClickableElementDetector`, and assigns each clickable element an integer selector index stored in a `selector_map` (index → node). `SerializedDOMState.llm_representation` renders the `SimplifiedNode` tree to text with `[index]<tag ...>` prefixes. Later, when the model calls `click(index=…)`, the tool resolves the index through the cached selector map back to the `EnhancedDOMTreeNode`, and `on_ClickElementEvent` executes the click over CDP using that node's `backendNodeId` + session.

## Architecture / call-chain diagram (text)

```
Agent step (agent/service.py:1090)
   └─ BrowserSession.get_browser_state_summary(...)   session.py:1587
        └─ dispatch BrowserStateRequestEvent(include_dom=True, include_screenshot=…)
             └─ DOMWatchdog.on_BrowserStateRequestEvent (dom_watchdog.py)
                  ├─ _capture_clean_screenshot(...)   (vision path)
                  └─ _build_dom_tree_without_highlights(previous_state)  dom_watchdog.py:551
                       └─ DomService.get_serialized_dom_tree(previous_cached_state)  dom/service.py:1096
                            ├─ DomService.get_dom_tree(target_id)  dom/service.py:703
                            │    └─ _get_all_trees(target_id)  dom/service.py:403
                            │         ├─ CDP: Page.getFrameTree → Accessibility.getFullAXTree per frame  (357)
                            │         ├─ CDP: DOMSnapshot.captureSnapshot(computedStyles=REQUIRED_COMPUTED_STYLES)  (571)
                            │         ├─ CDP: DOM.getDocument(depth=-1, pierce=True)  (583)
                            │         ├─ CDP: Page.getLayoutMetrics → device_pixel_ratio  (222)
                            │         ├─ JS eval: iframe scroll positions  (421)
                            │         ├─ JS eval: getEventListeners() click-listener backend IDs  (465)
                            │         └─ CDP DOMSnapshot per-doc limit (max_iframes)  (667)
                            ├─ build_snapshot_lookup(snapshot, device_pixel_ratio)  enhanced_snapshot.py:46
                            ├─ _build_enhanced_ax_node(...)  dom/service.py:194
                            ├─ _construct_enhanced_node(...)  dom/service.py:759   (recursive EnhancedDOMTreeNode builder)
                            │    └─ is_element_visible_according_to_all_parents(...)  dom/service.py:251
                            └─ DOMTreeSerializer(root, prev_state, paint_order_filtering, session_id)
                                 .serialize_accessible_elements()  serializer.py:110
                                      ├─ _create_simplified_tree(...)  serializer.py:451
                                      ├─ PaintOrderRemover.calculate_paint_order()  paint_order.py:165
                                      ├─ _optimize_tree(...)                    serializer.py:558
                                      ├─ _apply_bounding_box_filtering(...)     serializer.py:768
                                      ├─ _reserve_backend_node_ids(...)         serializer.py:633
                                      └─ _assign_indices_and_mark_new_nodes(...) serializer.py:656
                                          └─ ClickableElementDetector.is_interactive(node)  clickable_elements.py:6 (cached: serializer.py:430)
                                          └─ _allocate_selector_index(backend_node_id)  serializer.py:645
                                 = SerializedDOMState(_root=SimplifiedNode, selector_map={index: node})

BrowserWatchdog caches: session._cached_selector_map / _cached_selector_indices
   └─ session.update_cached_selector_map(selector_map)  session.py:2466

Prompt build (agent/prompts.py:252)
   └─ browser_state.dom_state.llm_representation(include_attributes=…)  dom/views.py:939
        └─ DOMTreeSerializer.serialize_tree(root, include_attributes)  serializer.py:922  → "[index]<tag>…</tag>" text lines
           (also SerializedState.eval_representation → DOMEvalSerializer, dom/views.py:954, eval_serializer.py)

Model chooses e.g. click(index=42)
   └─ tools/service.py _click_by_index  service.py:704
        └─ browser_session.get_element_by_index(index)  session.py:2480 → get_dom_element_by_index  session.py:2437 (cached selector-map)
             └─ dispatch ClickElementEvent(node=…)
                  └─ DefaultActionWatchDog.on_ClickElementEvent  default_action_watchdog.py:337
                       └─ _click_element_node_impl(element_node)  default_action_watchdog.py:702
                            └─ CDP: DOM.scrollIntoViewIfNeeded + click on backendNodeId/session (checkbox state reads, etc.)
```

## Key files + line refs
- `browser_use/dom/service.py` — `DomService` orchestrator: `get_serialized_state` (1096), `get_dom_tree` (703), `_get_all_trees` (403), `_get_ax_tree_for_all_frames` (357), `_get_viewport_ratio` (222), `is_element_visible_according_to_all_parents` (251), `_construct_enhanced_node` (759), iframe-hidden-counter `_count_hidden_elements_in_iframes` (80), `detect_pagination_buttons` (1154).
- `browser_use/dom/views.py` — data models: `EnhancedDOMTreeNode` (374, with xpath 492, element_hash 827, compute_stable_hash 830, is_actually_scrollable 623, scroll_info 720), `EnhancedSnapshotNode` (325), `EnhancedAXNode` (311), `SerializedDOMState` (931) + `llm_representation` (939), `SimplifiedNode` (218), `DOMSelectorMap` (915), `DOMInteractedElement` (977).
- `browser_use/dom/serializer/serializer.py` — `DOMTreeSerializer` pipeline: `serialize_accessible_elements` (110), `_create_simplified_tree` (451), `_optimize_tree` (558), `_apply_bounding_box_filtering` (768), `_reserve_backend_node_ids` (633), `_allocate_selector_index` (645), `_assign_interactive_indices_and_mark_new_nodes` (656), `serialize_tree` (922), `_build_attributes_string` (1130).
- `browser_use/dom/serializer/clickable_elements.py` — `ClickableElementDetector.is_interactive` (6): heuristic-clickability.
- `browser_use/dom/serializer/paint_order.py` — `PaintOrderRemover` (36) + `RectUnionPure` (7).
- `browser_use/dom/enhanced_snapshot.py` — `build_snapshot_lookup` (46) + `REQUIRED_COMPUTED_STYLES` (17).
- `browser_use/browser/watchdogs/dom_watchdog.py` — `_build_dom_tree_without_highlights` (551), `DomService` creation (558), selector-map caching (668).
- `browser_use/browser/session.py` — `get_browser_state_summary` (1587), `get_dom_element_by_index` (2437), `get_selector_index` (2454), `update_cached_selector_map` (2466), `_cached_selector_map` (562).
- `browser_use/tools/service.py` — `_click_by_index` (704), `dropdown_options` (923), `_register_click_action` (2110).
- `browser_use/browser/watchdogs/default_action_watchdog.py` — `on_ClickElementEvent` (337), `_click_element_node_impl` (702).
- `browser_use/agent/prompts.py` — `llm_representation` into message (252).
- `browser_use/dom/serializer/eval_serializer.py` — alternate judge-mode serializer (no indices).
- `browser_use/dom/serializer/html_serializer.py` + `static/dom/preview.js`(ui) — visual DOM inspection preview.
- `browser_use/dom/utils.py` — `cap_text_length`.

## Connections map (inbound / outbound)

### Inbound (what drives the DOM service)
- Agent loop: `agent/service.py:1090` requests `get_browser_state_summary`; `prompts.py:252` renders DOM; loop fingerprints via `llm_representation` (service.py:1531).
- Browser event bus: `BrowserStateRequestEvent` (session.py:1612) handled by DOMWatchdog; the same watchdog also handles tab switches and reuse of `previous_cached_state`.
- Screenshot/vision: `_capture_clean_screenshot` runs beside the DOM build; highlights (Python-side boxes) render from the selector_map (`python_highlights.py:409/501`), so the index the model sees in text matches the index visually highlighted in the screenshot.
- Actor/`Browser` facade: `actor/page.py:397` creates `DomService(self._browser_session)` for direct callers.

### Outbound (what the DOM feeds)
- Action execution: selector_map index → `EnhancedNode` → CDP click/mouse/scroll; `tools/service.py` uses it for click/input/select-dropdown; `session.get_dom_element_by_index` and `get_selector_index` for reverse mapping.
- Pagination/browsing: `detect_pagination_buttons` (service.py:1154) consumes the selector map to suggest prev/next actions.
- Telemetry/observability: `observe_debug` wrappers (`get_dom_tree`, `llm_representation`, etc.) and `cdp_timing` budget stats emitted from `_get_all_trees`.
- Cloud sync / history: current_dom_line feeds the conversation history and interactive-equivalent judgement via `eval_representation`.

## Impact analysis
- The DOM service is the single source of truth for what the model "sees": its tag/excluded/visible/interactive decisions directly control which actions are possible. If a clickable element is dropped by paint-order or bbox containment filtering, the model literally cannot `click` it — an indeliverable failure mode.
- The index scheme uniquely determines action targets. Because indices can shift between steps, the serializer diffs against `previous_node_ids` (serializer.py:72-79) and marks new elements `is_new` (`*`) in the text so the agent re-emits correct indices.
- Cross-cutting performance: visibility/detection runs once per captured step; the fine-grained timing breakdown (`cdp_calls_ms`, `build_snapshot_lookup_ms`, `assign_interactive_indices`) indicates this is reliably a top-step bottleneck.
- Security/Privacy: password/value fields are stripped before the snapshot is sent to the LLM (serializer.py:1220, `_build_attributes_string`), and platform logic keeps hidden elements out of the prompt while still hinting scroll-by-pages in iframes (service.py:80).
- Highlight consistency: same selector_map drives both text and screenshot highlight boxes.

## Gotchas / quirks
- Two different DOM-lookup paths coexist: main serialization works off a fresh CDP snapshot; actions resolve mostly from session._cached_selector_map, backed by the AX snapshot. Index mismatch can happen when DOM changes between state capture and the click event (`get_element_by_index` returns only cache hits).
- `data-browser-use-exclude` and the session-specific variant `data-browser-use-exclude-<sessionId>` are honored at serialization time (serializer.py:488), useful for suppressing legacy/widgets the user doesn't want the model to interact with.
- Bbox containment filtering is heuristic (relationally excludes only children ≥99% contained by a propagating `a`/`button`/combobox parent); exception rules (file inputs, aria-label) keep it from over-removing.
- The JS `getEventListeners` detector is guarded: it bails for >10000 elements and above a hard cap (100 elements with listeners) to avoid flooding the CDP socket (`service.py:474-490`).
- Attribute inclusion (which of ~60 props get shown) is a 2-phase process: `include_attributes` default is long but the serializer trims duplicates/redundant ones (e.g. `aria-expanded` vs `expanded`) to compactly-fit token budget. See `DEFAULT_INCLUDE_ATTRIBUTES` (views.py:18) + the attr-dedup in `_build_attributes_string` (serializer.py:1275-1318). Password values are never included.
```