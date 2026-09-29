# Timepass V1 — Feature Integration Picks (from analysis-reports)

> Analysis source: `analysis-reports/{browser-use,browserless,crawl4ai,ego-lite,Scrapling}/`
> Idea source: `Documents/Obsidian Vault/AI Research/timepass/my idea of timepass- a web browser automation.md`
> Component spec: `Documents/Obsidian Vault/AI Research/timepass/GEMINI.md`
> Scope: `docs/PLAN-v1-gemini-scope.md` (Gemini-only control + universal tab focus)

## Goal

Prevent the brittle tiered selector + polling DOM code in `extension/content.js` from breaking
when Google ships new Gemini UI, and give the agent near-zero-error control per the idea's
`0 error just like playwright` requirement (`my idea...md:34`). Confined to Gemini-only scope.

## V1 Integration Slice (3 items)

### 1. Ego-lite Ref map + Scrapling Adaptive selector
- **Source reports:** `analysis-reports/ego-lite/report-element-resolver.md`,
  `analysis-reports/Scrapling/report-adaptive-selection.md`
- **Problem it solves:** `findInputEditor`/`findSendButton`
  (`extension/content.js:343/418`) and `ModelPickerHandler`
  (`src/components/registry.ts:3`) break on `rich-textarea .ql-editor` class churn.
- **Steal:**
  - Ego-lite Ref system: `@N` = CDP `backendNodeId`; `resolveElementCenter` + ObjectId;
    `transient`/`permanent` resolution errors; AX-tree fallback when a cached node goes stale
    (`ego-lite/src/element-resolver.ts`, `src/ref-map.ts`).
  - Scrapling Adaptive: `save → retrieve → relocate` — on selector miss score the whole tree via
    `SequenceMatcher` (tag/text/attr/path), threshold `percentage`; persist fingerprints in a
    domain-scoped SQLite store keyed by component (`scrapling/parser.py`, `core/storage.py`).
- **Files to create/modify:** `src/components/ref-map.ts`, `src/components/element-resolver.ts`,
  `src/components/adaptive/store.ts`, wire into `registry.ts` + content resolution.
- **Result:** selectors auto-heal without redeploying; `ask` never fails on a rename.

### 2. Browser-use DomService fold
- **Source report:** `analysis-reports/browser-use/report-dom-service.md`
- **Problem it solves:** `DomReader` + `DomDiffer`
  (`extension/content.js:99/150`) is string-keyed `tag|cls|text`, no visibility/clickability,
  fixed `settleMs 3000`.
- **Steal:** fold 4 CDP sources (`DOMSnapshot.captureSnapshot` + `DOM.getDocument` + AX + DPR)
  into an `EnhancedDOMTreeNode`; `ClickableElementDetector` scores visibility/clickability;
  `selector_map` (index → node) for reliable completion detection.
- **Files:** upgrade `DomReader`/`DomDiffer` in `extension/content.js` + optional
  `src/driver/cdp-driver.ts` CDP-backed snapshot when `CdpDriver` active.
- **Result:** `CompletionHeuristic` (`content.js:175`) sees visibility/clickability signals, not
  just `textLen > 30`.

### 3. Ego-lite site-skills pack for Gemini
- **Source report:** `analysis-reports/ego-lite/report-learning-output.md`
- **Problem it solves:** GEMINI.md 17 components churn (plus sign, gems, thinking) — no versioned
  way to document/swap selectors without code deploy.
- **Steal:** static `learnings/<site>/manifest.json` pack (`notes/*.md` + `tools/*.js` +
  `browser-tools/*.js`), served via a `site.skillsForUrl` facade, offline-validated
  (`scripts/validate-site-skills.ts`).
- **Files:** `extension/skills/gemini/manifest.json`, `extension/skills/gemini/notes/*.md`,
  `extension/skills/gemini/tools/*.js`.
- **Result:** new Gemini handler = new tool file + schema; validated offline, no registry bloat.

## V2 Picks (deferred, not in this build)

- BrowserRuntime TTL+retry + SessionManager/agent_focus (ego-lite/browser-use) for 10-tab cap +
  window-per-agent isolation (`my idea...md:21-27`).
- Crawl4ai Pruning/BM25 structured output (`report-markdown-filters.md`,
  `report-extraction-strategies.md`) for organized multi-turn output files.
- Patchright stealth (`report-stealthy-fetcher.md`) + Browserless Limiter queue
  (`report-queue-metrics.md`, `report-ws-protocol.md`) only when expanding beyond Gemini.

## Build Process

1. Subagents run **sequentially** (one feature at a time) to avoid same-file conflicts.
2. Each subagent writes its progress/report to a **temp file inside the project dir only**:
   `<project>/.tmp-report-<agent>.md` (e.g. `.tmp-report-a-ref-adaptive.md`), not outside the repo.
3. Each subagent must: run `npm run typecheck`, `npm run lint`, and `npm test` before finishing,
   and report pass/fail explicitly.
4. Parent reviews each subagent's diff, watches for scope creep, then starts the next.
