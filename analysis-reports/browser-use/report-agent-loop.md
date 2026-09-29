# Feature: The Core Agent Loop (browser-use)

## One-Paragraph Summary

The Agent loop turns a natural-language `task` into a bounded, reactive sequence of LLM decide → execute → observe steps. `Agent.run()` opens a persistent `BrowserSession` (launching Chromium over CDP), runs any pre-computed `initial_actions`, then iterates `_execute_step()` up to `max_steps`. Each step, `Agent.step()` captures the current DOM+screenshot into a `BrowserStateSummary` (`_prepare_context`), rebuilds a per-page action schema, assembles a single state message, calls the LLM to produce a structured `AgentOutput` (thinking/eval/memory/next_goal/plan + a list of up to `max_actions_per_step` actions), executes those actions via `multi_act()` → `Tools.act()` → `Registry.execute_action()`, folds the resulting `ActionResult`s back into the message manager's short-term history + memory, updates a plan and a loop-detector, and writes a history item. Termination happens when the LLM calls the special `done` tool (which sets `is_done=True`) or when max steps / consecutive failures are exhausted. There is **no backtracking** in the graph-search sense — "recovery" is re-active planning, injected nudges, and a forced `done` at termination.

---

## Architecture / Call-Chain Diagram (text)

```
User prompt ──▶ Agent(task, llm, tools, browser_session)
                     │
        Agent.__init__ (service.py:135)
          • resolves LLM (default ChatBrowserUse), model/timeout-specific setup
          • builds Tools() registry + dynamic ActionModel/AgentOutput schemas (_setup_action_models:774)
          • detects start URL → initial_actions=[{navigate}] (_extract_start_url:2283)
          • constructs MessageManager(SYSTEM prompt) (:505)
          • AgentState, AgentHistoryList, file_system, screenshots, telemetry, eventbus
                     │
        AGENT.run(max_steps=500) (service.py:2506)  ── signal_handler (pause/resume/SIGINT)
                     │
   1. CreateAgentSessionEvent / CreateAgentTaskEvent (eventbus; cloud_events.py)
   2. browser_session.start() (:2563)  ── start Chromium via CDP, attach watchdogs ──┬─ captcha waiter
   3. _register_skills_as_actions() (:830)  ── skills become registry actions            (browser/session.py:517)
   4. _execute_initial_actions() (:3287) → multi_act(initial_actions) → history[0]
                     │
        while state.n_steps <= max_steps:         (run loop, service.py:2600)
           |   guards: paused→await event; failures >= max_failures+final → break
           ▼
        _execute_step(step, max_steps, step_info) (service.py:2441; step_timeout wrapper)
           └── ▶ Agent.step(step_info)            (service.py:1029, `@observe`+`time_execution_async`)
                  ├─ Phase 0: wait_if_captcha_solving; inject result into last_result (:1040)
                  ├─ Phase 1: _prepare_context(step_info) (service.py:1081)
                  │    ├─ get_browser_state_summary(screenshot=True)  (browser/session.py:1587)
                  │    ├─ _check_and_update_downloads; _check_stop_or_pause (:1100)
                  │    ├─ _update_action_models_for_page(url) (:4027)  ← rebuild schema w/ domain-filtered actions
                  │    ├─ prompt_description = registry.get_prompt_description(url) (registry:605)
                  │    ├─ message_manager.prepare_step_state (:1123 → msg/service.py:199)
                  │    ├─ _maybe_compact_messages (:1156 → msg/service.py:216)
                  │    ├─ message_manager.create_state_messages (:1133 → msg/service.py:424)
                  │    │      → AgentMessagePrompt().get_user_message(use_vision) (prompts.py:404; class:107)
                  │    ├─ _inject_budget_warning (:1547) / _inject_replan_nudge (:1458)
                  │    │      / _inject_exploration_nudge (:1474)
                  │    ├─ _update_loop_detector_page_state (:1521) + _inject_loop_detection_nudge (:1490)
                  │    └─ _force_done_after_last_step (:1562) OR _force_done_after_failure (:1573)
                  │         → schema swap AgentOutput → DoneAgentOutput (only "done")
                  │
                  ├─ Phase 2: _get_next_action (:1170)
                  │    │  input_messages = message_manager.get_messages() (msg/service.py:548)
                  │    │  await asyncio.wait_for(_get_model_output_with_retry(input_messages), llm_timeout)
                  │    │      _get_model_output_with_retry (:1664) → get_model_output (:1939)
                  │    │          llm.ainvoke(messages, output_format=self.AgentOutput, session_id)
                  │    │          [on rate-limit/provider error → _try_switch_to_fallback_llm (:1977)]
                  │    │          retry-on-empty-actions; truncate to max_actions_per_step
                  │    │  self.state.last_model_output = parsed
                  │    └─ _handle_post_llm_processing (:1700): step-callback + save conversation
                  │
                  ├─ _execute_actions (:1205) → multi_act(output.action) (service.py:2733)
                  │    │  cases / tools.act(action, ...) (tools/service.py:2168)
                  │    │      → Registry.execute_action (:registry/service.py:331) → action.function()
                  │    │         done tool sets is_done (tools/service.py:2074)
                  │    ├─ done-only-if-single (i>0) guard (:2763)
                  │    └─ page-change guards: terminates_sequence flag | URL/focus change (:2817-2831)
                  │
                  ├─ Phase 3: _post_process (:1213) → downloads, plan update (:1411),
                  │   loop-detector action record (:1502), failure counting, Final Result log
                  │
                  ├─ on exception: _handle_step_error (:1252) → max-total failures
                  │
                  └─ finally: _finalize (:1350) → _make_history_item (:1732) → AgentHistory
                                 history.add_item ; n_steps += 1 ; CreateAgentStepEvent (eventbus)
            │
        detone check: history.is_done()  (views.py:727)  ← last result is_done
            │            if done → log_completion + _judge_and_log (:1622) + register_done_callback → break
       │
    TELEMETRY + cleanup: _log_agent_event (:2183), UpdateAgentTaskEvent, GIF,
        eventbus.stop, Agent.close/ this.run browser kill
```

---

## Key Files & Line References

### Orchestrator — `browser_use/agent/service.py` (class `Agent`, line 133)
| Concern | Function | Verified lines |
|---|---|---|
| Entry / config / state wiring | `__init__` | 135 – 481 (ActionModel 456; sessions 474; message manager 505) |
| CTL pause/stub signal | `_check_stop_or_pause` | 1007 |
| One step (Phases 0–3) | `step` | 1029 – 1079 (def 1029) |
| Context assembly | `_prepare_context` | 1081 – 1154 |
| Message compaction gating | `_maybe_compact_messages` | 1156 |
| LLM call + timeout | `_get_next_action` | 1169 – 1202 (def 1170) |
| Action execution trigger | `_execute_actions` | 1205 |
| Post-step processing | `_post_process` | 1213 |
| Error intake | `_handle_step_error` | 1252 |
| CDP conn classifiers | `_is_connection_like_error` / `_is_browser_closed_error` | 1310 / 1326 |
| Step history + events | `_finalize` | 1350 |
| Plan state machine | `_update_plan_from_model_output` / `_render_plan_description` | 1411 / 1446 |
| Nudge injectors | replan / exploration / loop / budget | 1458 / 1474 / 1490 / 1536 |
| Instrumented force-done | `_force_done_after_last_step` / `_force_done_after_failure` | 1562 / 1573 |
| Judge (secondary LLM) | `_judge_trace` / `_judge_and_log` | 1587 / 1622 |
| Empty-action retry | `_get_model_output_with_retry` | 1664 |
| Structured LLM call | `get_model_output` | 1939 |
| Fallback LLM switch | `_try_switch_to_fallback_llm` | 1977 |
| Telemetry emit | `_log_agent_event` | 2183 |
| Alternate step-entry API | `take_step` | 2248 |
| Start-URL extraction | `_extract_start_url` | 2283 |
| Single step w/ timeout | `_execute_step` | 2441 |
| **Main loop** | `run` | 2506 |
| **Multi-action executor** | `multi_act` | 2733 |
| Initial-nav bookkeeping | `_execute_initial_actions` | 3287 |
| Per-page rebuild schema | `_update_action_models_for_page` | 4027 |

### Output/state/history schemas — `browser_use/agent/views.py`
| Model | Role | Lines |
|---|---|---|
| `MessageCompactionSettings` | prompt thresholds | 35 |
| `AgentSettings` | run config | 59 |
| `PageFingerprint` / `compute_action_hash` | loop-detector hashing | 95 / 151 |
| `ActionLoopDetector` | behavior-loop nudges (soft) | 157 |
| `AgentState` | mutable step/failure/plan/control state | 251 |
| `AgentStepInfo` | `is_last_step()` | 278 |
| `ActionResult` | action-return contract (`is_done`, `success`, `error`, `long_term_memory`) | 307 |
| `PlanItem` | planning items | 376 |
| `AgentBrain` | flattened eval/memory/next_goal | 381 |
| `AgentOutput` | LLM structured output (→ `type_with_custom_actions*`) | 388 / 419 |
| `AgentHistory` / `AgentHistoryList` | step + aggregate analysis, `is_done`/`is_successful` | 488 / 595 |

### Message/context manager — `browser_use/agent/message_manager/`
`views.py`: `HistoryItem`/`MessageHistory` (`get_messages` 74) / `MessageManagerState` — message order is `system → state → context`.
`service.py` (class `MessageManager`, init 107): `prepare_step_state` 199, `maybe_compact_messages` 216, `_update_agent_history_item` 304, `create_state_messages` 424, `get_messages` 548, `_add_context_message` 570.

### Tools/actions registry — `browser_use/tools/`
- `service.py` → `Tools.act(action, browser_session, ...)` (liigen 2168) dispatches with `asyncio.wait_for(action_timeout)` and normalizes every error into `ActionResult`; the **`done`** tool is registered by `_register_done_action` (line 1998) and returns `ActionResult(is_done=True, success=...)` (lines 2074–2080).
- `registry/service.py`: `action()` 291 (decorator), `execute_action()` 331, `create_action_model()` 517 (builds the Union schema for the LLM, domain-filtered per page), `get_prompt_description()` 605.

### Prompts — `browser_use/agent/prompts.py`
- `SystemPrompt` (28) selects `system_prompt*.md` templates per model+mode; `AgentMessagePrompt` (107) folds DOM snapshot, clickable-elements map, screenshots, agent-history text, plan, page-filtered actions, file paths, unavailable-skills info, sensitive-data placeholder list into one `state_message` via `get_user_message()` (404).

### Browser & DDM — `browser_use/browser/`
- `session.py` : `get_browser_state_summary` (1587, dispatches `BrowserStateRequestEvent`), `wait_if_captcha_solving` (517); `events.py` defines `NavigateToUrlEvent`, `ClickElementEvent`, `TypeTextEvent`, etc. that each action awaits via the event bus.
- `browser/dom/` service continuously caches the interactive-element selector_map (stale selectors are never used after navigation; page-change guard in `multi_act`).

---

## End-to-End Message / Memory Flow

1. Agent start: `MessageManager` holds a cached `system_message` (SystemPrompt) plus a `state_message` (rebuilt each step) and a per-step `context_messages` list.
2. Each step, `_prepare_context` → `create_state_messages` calls `MessageManager.message_history_description` and folds the previous step's `ActionResult`s into `agent_history_description` and `read_state_description` → a brand-new `state_message` replaces the old one (`_set_message_with_type`, state slot).
3. Phase 2 calls `get_messages()` → returns `[system, state, *context]`.
4. That message list is passed to `lim.ainvoke(..., output_format=self.AgentOutput)`; the LLM's validated `AgentOutput` is stored as `state.last_model_output`, with `action` truncated to `max_actions_per_step`.
5. `multi_act` executes each action through `Tools.act`/`Registry.execute_action`; the `ActionResult`s are collected into the step's `last_result`.
6. `_finalize` → `AgentHistory(model_output, action=result, state=BrowserStateHistory, metadata=StepMetadata)` is appended to `AgentHistoryList`. Each `ActionResult`’s `long_term_memory`/`extracted_content`/`error` feeds the next step’s "previous action result" prompt. Oversized content spills to the `FileSystem` and appears in `read_state` one-time; compaction + 60k-char truncation keep the prompt bounded.

---

## Connections Map (inbound / outbound)

**Inbound (the loop consumes):**
- **LLM abstraction** — `BaseChatModel.ainvoke(messages, output_format=AgentOutput)` (`llm/base.py`); the loop supplies `task`, `session_id`, and model-specific `llm_timeout`. Side LLMs: `page_extraction_llm` (for `extract`/compaction), `judge_llm`, and optional `fallback_llm` (rate-limit/provider switch).
- **BrowserSession** (`browser/session.py`) — `start()`, `get_browser_state_summary()`, `get_current_page_url()`, `cookies()`, `downloaded_files`, `wait_if_captcha_solving()`, `event_bus`, `kill()`. Each tool dispatches a domain event through `browser_session.event_loop`.
- **DOM service** — cached `selector_map` for element lookup, plus `dom_state.llm_representation()` for loop-page fingerprints and prompt.
- **Tools/actions registry** — the schema `self.ActionModel`/`self.AgentOutput` come from the registry; the loop decides *which* action to run and feeds per-run context to `Tools.act`.

**Outbound (how this loop affects the rest of the system):**
- **Telemetry** — `AgentTelemetryEvent` (elem via `_log_agent_event:2183`), Laminar spans through `observe`/`observe_*` decorators, `ProductTelemetry`.
- **Cloud/event bus** — `CreateAgent/Session/TaskEvent`, `CreateStepEvent`, `UpdateTaskEvent`, `CreateAgentOutputFileEvent` (from `cloud_events.py`) flow to the browser-use backend.
- **FileSystem + ScreenshotService + gif** — persisted files, per-step screenshots, optional `create_history_gif`.
- **Return API** — `AgentHistoryList` returned to the caller (`.final_result()`, `.urls()`, `.structured_output`, `.is_successful()`, `.save_to_file()`).
- **User callbacks** — `register_new_step_callback`, `register_done_callback`, `register_should_stop_callback`, `register_external_agent_status_raise_error_callback`, plus the `SignalHandler` (pause/resume/stop).
- **Replay subsystem** — `rerun_history`/`load_and_rerun` reuse saved `AgentHistory` (via `_update_action_indices` and the dropdown-menu reopen heuristics) on the same action-execution path.

---

## Impact Analysis
- **Determinism & DOM-freshness safety**: `multi_act` bundles `done` only as a single action, and aborts the remainder of the queue on a `terminates_sequence` flag or any run-time URL/focus change (`:2733`–`:2831`) — so the LLM never targets a stale page.
- **Failure containment**: every error funnels into `ActionResult(error=...)` via `_handle_step_error`; only single-action errored steps bump `consecutive_failures` (`:1229`). At the failure threshold, the loop injects a "only `done` available" message and swaps to `DoneActionModel` — graceful termination rather than a silent hang.
- **Token cost**: `state.agent_history_items` is rolled each step, and optional compaction (`compact_every_n_steps`=25 / `trigger_char_count`=40k, `message_manager/service.py:216`) plus 60k-char caps keep the prompt bounded on long runs.
- **Loop robustness**: `ActionLoopDetector` only ever *nudges* the LLM (never blocks), so legitimate repetition isn't killed but runaway loops are surfaced (`_nudge`).
- **Terminal semantics**: the `done` ActionType=within ActionResult sets `is_done`. `history.is_done()` (views.py:727) + `is_successful` decide judge/callback/telemetry. Hitting `max_steps` with no `done` appends a synthetic failing history entry and `run` returns an error history.

---

## Gotchas / Quirks
1. **No true backtracking.** Resolution is wholly *re-active* — the loop keeps prompting the LLM; there is no search tree or plan graph. The `plan` feature (`enable_planning`) is only a `PlanItem` status window with replan *nudges*, not a backtracking mechanism.
2. **Off-by-one step bookkeeping**: `run` uses `state.n_steps` but passes `n_steps - 1` as `step_number`; auto-run initial actions are recorded as step `0` without a DOM state; `_finalize` increments `state.n_steps` only at the very end.
3. **Model-forced vision downgrades**: DeepSeek and Grok-3 models force `settings.use_vision=False` inside `__init__`, silently changing vision behavior vs how the flag is documented.
4. **`done` single-action rule**: `multi_act` ignores/suppresses `done` if it isn't alone — if the model puts `done` after other actions, the tail is dropped with a debug-level note (may surprise users who see an incomplete batch).
5. **`final_response_after_failure` effectively extends the retry budget**: the stop guard is `consecutive_failures >= max_failures + int(final_response_after_failure)`, so a run actually tolerates `max_failures+1` erroring ("force done" re-inserts by design).
6. **Judge only on `done`**: the judge runs only when the terminal `done` result is present (`_judge_and_log`); on failure-triggered stops it never runs. Its verdict never overrides the agent's `success`, which can surprise consumers of `structured_output`/eval data.
7. **Prompt may exceed handcrafted templates**: the `state_message` is rebuilt each step from the DOM plus previous action-results — both `action_results` and `read_state_description` hard-truncate at 60k chars, meaning long extractions silently appear truncated to the model unless `include_extracted_content_only_once` spills to file.

*(All file:line references verified against the repo at dig time.)*