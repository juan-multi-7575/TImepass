# Timepass V1 Plan — Gemini-Only Control Scope

> Source idea: `Documents/Obsidian Vault/AI Research/timepass/my idea of timepass- a web browser automation.md`
> Component spec: `Documents/Obsidian Vault/AI Research/timepass/GEMINI.md`
> Current project: `my-opencli/timepass/`

## 1. Clarified Scope (corrected intent)

- **Control scope TODAY = Gemini only.** Only `gemini.google.com` tabs are navigated/controlled
  (typing, clicking, DOM, upload, model picking, etc.). No universal site control yet.
- **Tab focus = universal.** `tab-switch` / focus operations work for *any* tab in the profile,
  but action dispatch (`inject_and_send`, `dom_dump`, ...) remains Gemini-scoped.
- Current code already matches this for injection: `extension/manifest.json` `content_scripts.matches`
  is `https://gemini.google.com/*`, and `extension/content.js` only injects there.

## 2. Alignment with Current Code

| Area | Status | Evidence |
| :--- | :--- | :--- |
| Gemini-only content injection | ALIGNED | `extension/manifest.json:23`, `extension/content.js:3` |
| Typing / sending | ALIGNED | `src/components/prompt-input.ts`, `send-button.ts`, `extension/content.js:343/418/482` |
| File upload | ALIGNED (fragile, debugger-based) | `extension/background.js:295`, `src/adapter/gemini-adapter.ts:165` |
| History read / select | ALIGNED | `extension/content.js:439/459`, `src/cli.ts:97/109` |

## 3. Divergences to Resolve

### 3a. Tab Management (per `my idea...md:21-27`)

- **No tab groups** — idea says `i dont need a tab groups`. Current forces a `🤖 Timepass Gemini`
  group as an isolation barrier (`extension/background.js:71`, `docs/adr/0002`).
  - **Decision:** keep group but make it opt-out via `--no-group` flag (satisfies idea while
    protecting the user's personal profile). Or remove entirely to match the idea.
- **Universal tab focus** — `tab_list`/`tab_switch` today filter to `gemini.google.com/*`
  (`extension/background.js:551`, `src/adapter/gemini-adapter.ts:242`). Need dual-mode:
  `tab_list --all` (universal `chrome.tabs.query({})` for focus) vs `tab_list` (Gemini-filtered
  for control).
- **CSV / persistent registry** — idea wants a registry of opened/closed tabs, auto-managed.
  Current has no persistence (only live `chrome.tabs.query`). Defer to `v2`, or minimal
  `tabs.json` next step.
- **Closed-tab tracking** — idea wants to know/reopen closed tabs. Current `getOrCreateGeminiTab`
  just recreates (`extension/background.js:133`). Defer to `v2` via `chrome.sessions`.
- **~10 tab cap** — idea wants a consumption limit. Not enforced today. Defer to `v2`.
- **Window-per-agent-session isolation** — idea wants a separate window per agent session. Current
  uses a single WebSocket server + single client socket (`src/driver/extension-driver.ts:18`).
  Defer to `v2`.

### 3b. Missing Gemini Component Handlers (per `GEMINI.md:2`)

Only 5/17 handlers exist in `src/components/registry.ts:3`. Missing for Gemini-only scope:

- Extended thinking on/off (model switch is disabled at `extension/content.js:497`)
- Stop button while generating (no cancellation in `CompletionHeuristic`)
- Sidebar toggle
- New chat via UI click (currently only `payload.url` hack at `src/adapter/gemini-adapter.ts:67`)
- Gems (Projects) CRUD — create/select/delete, fields name/desc/inst/tools/knowledge
  (`GEMINI.md:22-46`)
- Deep Research
- Image generation (query-type detection: text vs image-gen)

### 3c. Adaptive Watchdog (per `my idea...md:17-18`)

- Idea: timeout pre-decided by `model + site + thinking + query type`; signal `output complete`;
  agent receives signal; CLI stops vs persistent interactive mode; one-shot closes tab.
- Current: fixed heuristic — `settleMs 3000`, `timeoutMs 60000`, `pollMs 600`
  (`extension/content.js:277`), output always overwrites single `response.md`
  (`src/cli.ts:235`), `adapter.close()` always called (`src/cli.ts:278`).
- **Plan:** adaptive `timeoutMs = base(model) * thinkingFactor * queryTypeFactor`; expose
  `turn_complete` event for the agent; structured output dir
  `timepass/outputs/<timestamp>-<model>/<query>/response.md`; persistent interactive mode vs
  one-shot (close tab).

## 4. V1 Ticket Outline

1. Universal tab-focus fix — dual-mode `tab_list --all` / `tab_switch` for any tab
   (`extension/background.js:550`, `src/cli.ts:148`).
2. `--no-group` flag to opt out of Tab Group isolation (`extension/background.js:71`,
   `docs/adr/0002`).
3. Missing Gemini handlers — extended thinking, stop, sidebar, new chat, gems, deep research,
   image gen (`src/components/`).
4. Adaptive watchdog + `turn_complete` signal + structured output
   (`extension/content.js:175`, `src/adapter/gemini-adapter.ts`).
5. (v2) CSV/tabs registry, closed-tab tracking, 10-tab cap, window-per-agent-session.

## 5. Open Decisions

- Keep Tab Group (opt-out) vs remove entirely.
- Whether Gems / Deep Research / Image gen ship in `v1` or `v2`.
- Structured output dir vs single `response.md` for `v1`.
