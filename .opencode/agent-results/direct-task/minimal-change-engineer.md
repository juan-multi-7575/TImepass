# Minimal Change Engineer — DOM reader visibility/clickability scoring

source set: direct-task
agent name: minimal-change-engineer

## Context discovered

- finding: Working tree already contained most of the task's implementation from a prior interrupted session; minimal-diff path was verify-inherited-work + fill gaps, not rewrite.
  evidence: extension/content.js:114-175 (scoring pass), :202-249 (heuristic feed), src/components/dom-service.ts:1-65 — all pre-existing (mtime ~00:12, before this session).
- finding: Prior session's report `.tmp-report-a-ref-adaptive.md` documents feature A (RefMap/ElementResolver/AdaptiveStore) landed the same way; the content.js diff vs HEAD is 320 insertions mixing feature A + B.
  evidence: .tmp-report-a-ref-adaptive.md:14-17, `git diff HEAD --stat -- extension/content.js` = 320 insertions, 39 deletions.

## Changes made this session (the actual minimal diff)

- finding: Fixed stray 2-space indentation on the observeResponse baseline log line (line was inside this task's touched block and deviated from file style).
  evidence: extension/content.js:334 (was `    console.log('[Timepass] broad observeResponse start...`, now 2-space).
- finding: Created missing vitest test `dom-service.test.ts` — plain-object fake DOM, no jsdom; stubs global `getComputedStyle` via `vi.stubGlobal`; 4 branch tests: pointer-cursor button (visible+clickable, clickScore 0.9), visibility:hidden, aria-disabled=true, opacity:0.
  evidence: src/components/dom-service.test.ts:1-57
- finding: Wrote required report with files/design/verification sections.
  evidence: .tmp-report-b-dom-service.md

## Spec conformance verification of inherited work

- finding: Selector list matches spec exactly: `button, [role="button"], a[href], input, select, textarea, [contenteditable="true"], [onclick], mat-icon-button, gem-icon-button`.
  evidence: extension/content.js:114, src/components/dom-service.ts:21-22
- finding: Performance guard correct: style reads only for nodes with non-null rect, matching candidate selector, capped at MAX_STYLE_READS_PER_SNAPSHOT=2000 per snapshot; cheap `styleReads < cap` check runs before `matches()`/`getComputedStyle`.
  evidence: extension/content.js:115, extension/content.js:151
- finding: stats.clickable added; buttons count unchanged.
  evidence: extension/content.js:167-172
- finding: CompletionHeuristic feed correct: setBaseline stores baselineCopyCount/baselineClickableCount/baselineTextLen; hasNewClickableSignal uses `/copy|share|export|thumbs/i` vs baseline delta; isComplete adds `clickable+stable` (2000ms) as an ADDITIONAL signal — copy+stable and stable paths preserved.
  evidence: extension/content.js:211-248, extension/content.js:330 (setBaseline call in observeResponse)
- finding: TS counterpart matches required shapes: `ScoredNode`, `DomStats {total, visible, clickable, buttons}`, `DomService.scoreNode(node: Element)` and `DomService.scoreSnapshot(nodes: ScoredNode[])` statics with identical heuristics.
  evidence: src/components/dom-service.ts:1-65
- finding: Untouched per constraints: src/driver/cdp-driver.ts still stub (28 lines, no CDP impl), src/adapter/types.ts, src/cli.ts, src/components/model-picker.ts.
  evidence: src/driver/cdp-driver.ts:4-28

## Verification results (all run this session)

- npm run typecheck → PASS (exit 0)
- npm test → PASS: Test Files 2 passed (2), Tests 5 passed (5) — dom-service.test.ts (4) + registry.test.ts (1)
- npm run lint → PASS: 0 errors, 12 warnings (all pre-existing in extension/, unchanged set)
- node --check extension/content.js → SYNTAX_OK

## Follow-ups noted but not done

- Lint warnings in extension/content.js (prefer-const x2, unused vars) are pre-existing and outside task scope.
- `heuristic.baselineCopyCount` log at content.js:334 is debug-oriented; fine to keep since prior session established it.
- TS `DomService` has no `hasNewClickableSignal` counterpart — spec only required scoreNode/scoreSnapshot on the TS side; noted in case a future TS-side completion heuristic lands.
