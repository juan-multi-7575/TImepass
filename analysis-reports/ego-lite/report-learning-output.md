# Ego-lite: Learning Subsystem + Run Output/Artifacts Flow

## Feature name
Reusable per-site "learnings" (site-skill packs) + the run output sink / screencast artifact capture.

## One-paragraph summary

ego-lite learns per-domain browser knowledge as **static `learnings/<site>/` packs bundled under `skills/ego-browser/`** — each pack is a `manifest.json` declaring `domains`, `notes/*.md`, Node-side `tools/*.js`, and browser-side `browser-tools/*.js`, plus schemas for every tool. The three files in `src/learning/` discover/validate those packs and expose them to agents through the `site.*` facade (`site.skills`, `site.skillsForUrl`, `site.runTool`, `site.runBrowserTool`, `site.learnContext`): notes and tool signatures are served wholesale as context, Node tools are dynamically `import()`ed and called with the full helper context, and browser tools are read to source and `evaluate()`d in-page. Separately, because agents only read `console.log`, `src/output-sink.ts` **buffers** all script output and, on a hard stop, discards the whole buffer and emits the single owned guidance line (wired via `buildEgoError→markHardStop`), appending an update-notice trailer last; `src/video-recorder.ts` + `driver/screencast.ts` capture `Page.screencastFrame` events through an FFmpeg subprocess into a VP8 WebM, temp-name-then-rename atomic artifact.

## Architecture / call-chain (text diagram)

**Learning read path**
```
agent script
  site.skills(url?) / site.skillsForUrl(url) / site.learnContext(url?)
    └─ helpers.siteSkills/siteSkillsForUrl/learnContext  (helpers.ts:475/464/513)
        └─ state.agentWorkspace()  → env.agentWorkspace()  (env.ts:8)
             EGO_BROWSER_AGENT_WORKSPACE | bundled skills dir | repo skills/ego-browser
        └─ siteSkillsForUrl(url) → learningsRoot = <ws>/learnings  (check-domain-learning.ts:67)
             iterLearningDirs (skip "_*" dirs) → loadLearningManifest → domainMatches(hostname)
             → learningEntry → index.ts loadLearnedContext → read notes/*.md + schemas
```

**Tool execution path**
```
site.runTool(siteId, tool, args)           helpers.ts:487
  └─ index.runNodeSiteTool → findSiteSkill → dynamic import(<site>/tools/<file>.js?t=now)
       → callable(ctx, args)   where ctx = full helperContext()  (index.ts:145-176)
site.runBrowserTool(siteId, tool, args)    helpers.ts:500
  └─ loadBrowserToolSource (read source file) → wrapBrowserTool (IIFE)
       → evaluate(wrappedSource)  → cdp Runtime.evaluate in page (index.ts:178-196)
```

**Validation path (offline/CI)**
```
npm run validate:learnings  package.json:19
  └─ scripts/validate-site-skills.ts → validateSiteSkills → validateLearning(siteDir)
       manifest fields, strict path shapes (notes/*.md, tools/*.js, browser-tools/*.js),
       imports node callable, rejects temp `@N` refs  (validate-learning-format.ts)
```

**Output capture flow**
```
stdin JS → runMain → executionContext() overrides console.log → bufferOutput (run.ts:143)
   └─ flushSink(stdout, thrown) at end (run.ts:129):
        hard stop? → drop buffer, emit owned guidance once    (ego-errors.ts:142/153 buildEgoError→markHardStop)
        else      → flush verbatim
        + append update-notice trailer last (setNoticeTrailer, index.ts:194)
SDK path: installEgoSdk → console.log=cliLog|createBufferedLog + installLifecycleFlush (index.ts:180-186)
```

**Screencast/video artifact path**
```
page.screencast.start({path}) → driver/screencast.ts:35
  → ensureSession → VideoRecorder.start (ffmpeg image2pipe→vp8 webm, temp file)
  → subscribeBrowserEvent("Page.screencastFrame") → writeFrame(base64) → Page.screencastFrameAck
  → stop → stopScreencast (also page.stopScreencast) → recorder.stop → atomic rename temp→out  (video-recorder.ts:181)
```

## Key files + line refs

- `src/learning/check-domain-learning.ts` — pack storage model + discovery. `learningsRoot()` `:67`; `siteSkillsRoot` alias `:71`; `siteSkillsForUrl` hostname matching `:106`; `iterLearningDirs` (skips `_`-prefixed) `:134`; `loadLearningManifest` `:147`; `urlHostname`+`domainMatches` (exact or `*.suffix`) `:191/202`.
- `src/learning/index.ts` — facade over the packs. `loadLearnedContext(url)` builds `LearnedContext{knowledge[],tools[],exists,siteId,domain}` `:46`; only loads `notes/*.md` content via `isLearningNotePath` `:120`; tool signatures carry a usage `example` `:85/92/98`; `runNodeSiteTool` dynamic import + path-traversal guards `:145-176`; `loadBrowserToolSource`/`wrapBrowserTool` `:178-196`; `relativeSitePath` enforces containment `:218`.
- `src/learning/validate-learning-format.ts` — `validateLearning` `:14`, `validateLearnings`(=validateSiteSkills) `:87`; strict path shapes (`isNotePath`/`isNodeToolPath`/`isBrowserToolPath` `:206-219`), value-schema types `TOOL_VALUE_TYPES` `:11`, and **rejects temporary snapshot refs** `@N`/`ref=` in notes & tools `rejectTemporaryRefs` `:227`.
- `src/helpers.ts` — facade glue: `siteSkills` `:475`, `runSiteTool` `:487`, `runSiteBrowserTool` `:500`, `learnContext` `:513`; `createSiteFacade` bundles the five methods `:799`; `helperContext()` is the single injected surface `:822`; `loadAgentHelpers()` reads `<ws>/agent_helpers.js` `:852`.
- `src/index.ts` — CLI vs SDK split `isDirectCli` `:256`; `installEgoSdk` `:144`; routes the site facade to `target.ego.learnings` `:197`; wraps mutating ego methods to invalidate circuit/CDP session `wrapInvalidating` `:281`, `wrapCreateTab` `:303`.
- `src/ego-errors.ts` — `buildEgoError` single birthplace that calls `markHardStop(message)` `:142/153`; hard-stop codes `EGO_TASK_SPACE_USER_IN_CONTROL` & `EGO_TASK_SPACE_INACTIVE` `isEgoHardStopCode` `:123`; owned wording `EGO_ERROR_MESSAGES` `:48`.
- `src/output-sink.ts` — `bufferOutput` `:33`, `setNoticeTrailer` `:42`, `markHardStop` `:51`, `flushSink` `:66`, `installLifecycleFlush` (beforeExit/exit) `:109`.
- `src/run.ts` — `runMain` arg/flag handling `:61`, `execute` (reset + AsyncFunction + stopScreencast + flushSink) `:108`, `executionContext` overrides `console.log` `:133-147`.
- `src/video-recorder.ts` — `VideoRecorder.start` spawns FFmpeg `:38`, temp output path `:41`, frame pacing/dedup `writeFrame` `:121` & `_queueFrames` `:188`, `stop` renames temp→final `:139-186`.
- `src/driver/screencast.ts` — `startScreencast` `:35`, `stopScreencast` `:129`; injectable `createRecorder` seam `:23`; fallback single screenshot if no frames `:138`.
- `scripts/validate-site-skills.ts` — offline validation entry `:9`.
- Pack examples: `skills/ego-browser/learnings/google/manifest.json` (google.com domains, `search_and_extract` Node tool, `get_autocomplete_suggestions` browser tool), `skills/ego-browser/learnings/x-com/manifest.json` (3 tools).
- `spec/agent-skills-spec.md` — stub, just a pointer to https://agentskills.io/specification (no repo-local spec).

## Connections map

**Inbound to learning**
- `helpers.ts` (all five site methods) → depends on `state.agentWorkspace()` + `learning/index.js`.
- `src/index.ts` `target.ego.learnings` hosts the site facade for the SDK embedding path.
- Env resolution (`agentWorkspace`) decides which `learnings/` tree is read (per-user `EGO_BROWSER_AGENT_WORKSPACE` vs bundled vs repo).
- `scripts/validate-skill-site.ts` (and `npm run validate:learning`) invokes the validator.

**Outbound from learning**
- `runSiteBrowserTool` → `evaluate()` (→ `src/cdp-eval.ts` + driver) to run `browser-tools/*.js` in-page.
- `runSiteTool` → injects the full `helperContext()` (page/taskSpaces/fetch/etc.) into Node tools — tools are full-fidelity agent code, not sandboxes.
- `loadLearnedCleanContext` consumption: agent reads notes = static, versioned knowledge; no persistence/write path — learning is read-only, replay-only, there is no "train/store learned" writer.
- Validation enforces agents cannot bake in unstable `@N` snapshot refs (only stable locators) — ties learning quality to the element-resolver/ref model.

**Inbound to output-sink**
- `run.ts` (CLI) + `index.ts installEgoSdk` (SDK) both route `console.log` in.
- `ego-errors.ts buildEgoError` feeds `markHardStop`.
- `update-notice.ts emitUpdateNotice` feeds `setNoticeTrailer` (only on the default buffered-sink path; a host cliLog gets the line directly).

**Outbound from output-sink**
- Writes to `process.stdout` (CLI `flushSink(stdout)` / SDK lifecycle), or host-supplied `cliLog`.
- Ordering invariant: business output (or owned hard-stop guidance) THEN update notice trailer.
- `flushSink(thrown)` semantics: uncaught error → drop buffer, stay silent, let the propagating Error surface; clean finish → print owned hard-stop message or flush verbatim.

**Screencast/video connections**
- `driver/screencast.ts` ⇄ `browser-runtime.ts` (`ensureSession, `subscribeBrowserEvent`, `browserCdp` for `Page.startScreencast`/`stopScreencast`/`screencastFrameAck`/`captureScreenshot`).
- Exposed through `page.screencast.{start,stop}` facade (`helpers.ts`) and surfaced as `page.screencast` in `FACADE_HELP`/`format.ts` doc map (lines ~737).
- `stopScreencast` is called from `run.ts execute()` (line 123) so a plain CLI run cleanly tears down a recording even on throw.

## Impact analysis

- **Determinism**: learning is 100% read-only static packs → replayable cross-round; no mutable knowledge DB, no background training, no cross-process state (matching "each heredoc is a fresh process" model).
- **Agent capability amplification**: `site.runTool`/`runBrowserTool` let agents skip re-deriving site-specific flows (Google SERP extraction, X timeline anti-click-wrap); `learnContext` gives exact tool arg/return/example schemas for tool-calling agents.
- **Output correctness under concurrency/takeover**: buffering is what makes a single clean hard-stop line possible even when the agent loops and swallows errors — prevents console noise during user control. Cost: nothing streams until the run ends (latency trade-off).
- **Deterministic teardown**: sink flushes on both `beforeExit` (clean) and `exit` (thrown) so output is not lost on uncaught async rejection; video recorder falls back to a single screenshot if no frames arrive, guaranteeing a non-empty artifact.
- **Update-notice UX** appears as a footer, not a prefix — improves agent marking of the notice as out-of-band.

**Calling Attention — noteworthy details**
- No "learning" happens at runtime: the name is a marketing/abstraction name for "curated static site packs."
- A pulled-in Node tool can mutate the workspace; the only guard is `relativeSitePath` path containment — it is not a sandbox (it's trusted repo content).
- `runBrowserTool` executes src as text via `eval` wrapper — same goal different mechanism than `runSiteTool`.
- `siteSkillsForUrl` uses the URL's `hostname` only (host habitation), so `google.com`/`*.google.com` both match `www.google.com`; query params are irrelevant.
- The update-notice/`console.log` override is per-process (fresh short-lived process each heredoc), so `resetSink()` exists only for in-process tests — no cross-round reset concern.
- `video-recorder.ts` is not exercised by learning; strictly an output/artifact capture artifact tied to `page.screencast` (activity-graph artifact, not learning).