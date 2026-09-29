# Deep-Dig Report: The Element Resolver + Ref System

**Repo:** ego-lite (`package/ego-browser/src/`)
**Feature:** Element ref lifecycle — assign → store → resolve → invalidate — plus locator resolution and staleness handling.
**Feature path:** `src/element-resolver.ts`, `src/ref-map.ts`, `src/ref-state.ts`, `src/locator-query.ts`

---

## 1. Summary

`ego-browser` lets AI agents refer to on-page elements by short-lived numeric refs (``@N``) that appear in the semantic `snapshot()` text. Refs are just CDP `backendNodeId`s, re-keyed by the same numbers that render into the snapshot's `[ref=N, loc=…]` annotations. Every call to `snapshot()`/`snapshotRaw()` rebuilds the in-memory `RefMap` from the browser-produced ref list, and the resolver module (`element-resolver.ts`) turns any accepted target form — ``@N``/`ref=N`, `loc=css:`, `loc=role:`, `loc=href:`, `text:`, `label:`, `xpath=`, Playwright-style `:has-text()`, internal `scope`/`filter`/`nth` selectors, or raw CSS — into either a click point (center of the `DOM.getBoxModel` quad) or a `Runtime` `objectId` handle. Resolution failures are classified as `transient` (retryable: not found / not rendered / stale) or `permanent` (bad selector / ambiguous match), and wait loops rely on that contract. A ref whose cached backend node has gone stale transparently falls back to an AX-tree role/name re-lookup; a ref used while the map is empty triggers an automatic re-snapshot, which is what makes refs survive across separate heredoc rounds.

## 2. Architecture / call-chain diagram

```
                       ⇑ = assign/feed refs      ⇓ = consume resolved targets
                 (closed-source ego app, via browserEgo())

 Agent stdin JS
   │  page.snapshot() / snapshotText()
   ▼
 driver/observe.ts snapshotRaw() ──► browserEgo().snapshot() ──► { content, refs[] }
   │                                    (refs: [{backendNodeId, role, name}])
   └─► browserSnapshotRefsToRefMap(browserRefMap, refs)     [browser-runtime.ts:309]
         │  RefMap.clear() + RefMap.add(String(backendNodeId), …)
         ▼
   ref-state.ts browserRefMap  (module singleton RefMap, entries {backendNodeId,role,name,nth,selector,frameId})
         ▲  registerSnapshotForRefRefresh(snapshotRaw)   [observe.ts:65]
         │         ┌────────────────────────────────────────────┐
         └─────────┤ ensureRefMapForRef(@N)  → re-snapshot when map EMPTY [ref-state.ts:12] │
                   └────────────────────────────────────────────┘

 Agent action helpers (click/hover/fill/read/upload/wait) accept "selectorOrRef"
   │
   ├─► pointer.resolveMouseTarget ─► waitForSelector(resolveHandle) + elementCenter()
   ├─► driver/element-ops.ts resolveHandle() / resolveAndCall() / withHandle()
   ├─► driver/locator.ts  readElement* / count / evaluateAll
   ├─► driver/keyboard.ts focus/fill/check/selectOption/dispatchEvent
   ├─► driver/files.ts    setInputFiles
   └─► driver/waits.ts     waitForSelector polling loop
        │ (each calls ensureRefMapForRef + parseRef first)
        ▼
   src/element-resolver.ts  (the single resolver = "unified target surface")
     │  parseRef()? → locator (parseLocator())? → raw selector
     │
     ├─► resolveElementCenter()      [element-resolver.ts:63]  → click point {x,y,sessionId}
     │      ref path: DOM.getBoxModel(backendNodeId) → boxModelCenter()
     │            fallback on stale node: findBackendNodeIdByRoleName() (AX tree re-lookup)
     │      locator path: resolveLocatorCenter()
     │      raw path: Runtime.evaluate(buildSelectorCenterJs())
     │
     └─► resolveElementObjectId()    [element-resolver.ts:149] → {objectId,sessionId}
            ref path: DOM.resolveNode(backendNodeId) [objectGroup "ego-browser"]
            locator path: resolveLocatorObjectId()  (role via AX, else count-then-find)
            raw path: Runtime.evaluate(buildFindElementJs())
     │
     ▼
   CDP commands routed via cdp-eval.cdp() → state.send → browser-runtime.browserCdp()
        (session attach/caching 2s TTL, session -loss retry, buffered events)
```

## 3. Key files + line references

### `src/ref-map.ts` — the store (55 lines)
- `RefMap` class with `map: Map<string, any>` (`ref-map.ts:1-41`). Entries: `{ backendNodeId, role, name, nth, selector, frameId }` (`ref-map.ts:20-27`).
- `add()` (`ref-map.ts:8-10`) delegates to `addWithFrame(..., undefined)` (`ref-map.ts:12-28`).
- `parseRef()` (`ref-map.ts:43-55`) — accepts ``@N``, `ref=N`, or a bare all-digits string. **Quirk:** a purely-numeric string like `"123"` is treated as ref 123 even without a prefix.

### `src/ref-state.ts` — the lifecycle glue (24 lines)
- `export const browserRefMap = new RefMap()` (`ref-state.ts:3`) — global singleton.
- `registerSnapshotForRefRefresh(fn)` (`ref-state.ts:8-10`) stores the refresh callback.
- `ensureRefMapForRef(selectorOrRef)` (`ref-state.ts:12-24`) — **only re-snapshots when the *entire* map is empty** (`browserRefMap.map.size > 0` short‑circuits at `ref-state.ts:16`). Guarded by an `ensuring` re-entrancy flag (`ref-state.ts:5,18`).

### `src/browser-runtime.ts` — the assign side
- `browserSnapshotRefsToRefMap(refMap, refs)` (`browser-runtime.ts:309-326`) — `clear()` then `add()` per ref; skips non-objects and refs without a `backendNodeId` (`browser-runtime.ts:312-317`). Uses `refMap.add`, **not** `addWithFrame` — so snapshot refs carry no `frameId` and `nth` is `undefined`.

### `src/driver/observe.ts` — entry point for ref assignment
- `snapshotRaw()` (`observe.ts:49-63`) calls `browserEgo().snapshot(options)` (`observe.ts:52`) then `browserSnapshotRefsToRefMap(browserRefMap, result.refs || [])` (`observe.ts:61`).
- `registerSnapshotForRefRefresh(() => snapshotRaw())` (`observe.ts:65`).
- `elementCenter(selectorOrRef)` (`observe.ts:82-90`) — `ensureRefMapForRef` then `resolveElementCenter({sendRaw:cdp}, undefined, browserRefMap, …)`.

### `src/element-resolver.ts` — the resolver core (913 lines)
- `ElementResolutionError` with `kind: "transient" | "permanent"` (`element-resolver.ts:4-11`).
- `resolveElementCenter()` (`element-resolver.ts:63-147`) — ref → locator → raw CSS, returns click point.
- `resolveElementObjectId()` (`element-resolver.ts:149-238`) — ref → locator → raw CSS, returns runtime handle.
- `resolveFrameSession()` (`element-resolver.ts:240-248`) — maps `entry.frameId` → iframe CDP session.
- `resolveLocatorCenter()` / `resolveLocatorObjectId()` (`element-resolver.ts:250-374`).
- `findBackendNodeIdsByRoleName()` (`element-resolver.ts:424-467`) — the AX-tree re-lookup: `Accessibility.getFullAXTree` filtered by role/name, returning `backendDOMNodeId`s; **throws `permanent` if an AX match lacks a `backendDOMNodeId`** (`element-resolver.ts:458-463`).
- `findBackendNodeIdByRoleName()` (`element-resolver.ts:396-422`) — picks `nth` match (defaults index 0), throws `transient` when absent.
- `findUniqueBackendNodeIdByRoleName()` (`element-resolver.ts:469-489`) — throws `permanent` on “matched N (>1) elements”, `transient` on 0.
- `boxModelCenter()` (`element-resolver.ts:853-868`) — averages the 8-point content quad; **degenerate/missing quad throws `transient` ("no box model") instead of returning (0,0)** — the comment at `element-resolver.ts:855-859` documents that a fake (0,0) would silently click the viewport corner.
- `matchCountKind()` (`element-resolver.ts:46-50`) — `"matched N elements"` with N>1 → `permanent`; otherwise `transient`.
- `selectorResolutionError()` (`element-resolver.ts:52-61`) — wraps eval exceptions.
- `parseLocator()` (`element-resolver.ts:714-819`) — the grammar for `loc=` + kind prefixes and `internal:nth=` / `internal:last;` wrappers.
- `parseLocatorName()` (`element-resolver.ts:821-844`), `parseTextLocator()` (`element-resolver.ts:846-851`) — quote stripping + JSON `{text|exact|regex}` matcher parsing.
- `axNameMatches()` (`element-resolver.ts:881-901`) — AX name compare supporting regex/exact/substring and numeric/boolean AX values.
- `send()` (`element-resolver.ts:911-913`) — thin wrapper on `cdp.sendRaw`.

### `src/locator-query.ts` — the selector-to-JS-string compiler (446 lines)
- `queryAllExpression(selector, rootExpression)` (`locator-query.ts:21-117`) — single entry; emits a browser-side expression for *any* selector form. Handles `internal:nth=`, `internal:last;`, `internal:scope:`, `internal:filter:` JSON envelopes, then `xpath=`, `css:`, `href:`, `text:`, `text=`, `label:`, `placeholder:`, `alt:`, `title:`, `testid:`, `role:`, else plain CSS.
- `querySelectorAllExpression()` (`locator-query.ts:170-181`) — CSS with Playwright `:has-text()` support (`parsePlaywrightHasTextSelector`, `locator-query.ts:183-200`).
- `roleElementsExpression()` (`locator-query.ts:358-405`) — browser-side AX-ish role modeling: explicit `role` attr or implicit-role mapping from tag (button/link/textbox/combobox/img/heading/checkbox/radio/slider) + `accessibleName()` heuristic (aria-labelledby → aria-label → alt → input value → labels → innerText, `locator-query.ts:360-379`).

### Supporting wiring
- `src/driver/element-ops.ts` — `resolveHandle()` (`element-ops.ts:13-21`), `releaseHandle()` (`element-ops.ts:30-37`), `withHandle()` (`element-ops.ts:45-52`), `resolveAndCall()` (`element-ops.ts:63-84`). **Every ref-consuming element op outside observe goes through this module.**
- `src/driver/waits.ts:491-532` — `waitForSelector` polls `transient` errors (sleep 300ms), re-throws `permanent`.
- `src/driver/locator.ts:304-320` — `readElement` retry loop on `transient` until `state.defaultTimeout`; `readOptionalElement` (`locator.ts:327-341`) converts `transient` → fallback value (so `isVisible`/`isEnabled` return false instead of throwing).
- `src/driver/pointer.ts:602-654` — `resolveMouseTarget` drives click/hover: `waitForSelector` → `scrollIntoViewIfNeeded` → `elementCenter`.
- `src/helpers.ts` exports the whole surface (snapshot/snapshotRaw/elementCenter at `helpers.ts:83-89`); `src/index.ts` registers them as globals / `page.*` facade (`index.ts:76-139`); `page.locator` facade wraps locator ops (`helpers.ts:560-602`).

## 4. Connections map

### Inbound (feed the ref system)
| Source | Mechanism | Ref |
|---|---|---|
| Closed-source ego app | `browserEgo().snapshot()` returns `{content, refs[{backendNodeId,role,name}]}` | `observe.ts:52` |
| `browserSnapshotRefsToRefMap` | clear+repopulate `browserRefMap` on every snapshot | `browser-runtime.ts:309-326`, `observe.ts:61` |
| `registerSnapshotForRefRefresh` | registers `snapshotRaw` as the auto-refresh impl | `observe.ts:65` → `ref-state.ts:8-10` |
| `cdp-eval.cdp` / `state.send` / `browserCdp` | transport for all CDP calls (`Accessibility.getFullAXTree`, `DOM.getBoxModel`, `DOM.resolveNode`, `Runtime.evaluate`) | `cdp-eval.ts:12-26`, `state.ts:42-44`, `browser-runtime.ts:79-105` |
| `driver/nav.ts iframeTarget` | latent `iframeSessions` plumbing (see gotchas) | `element-resolver.ts:240-248`, `491-503` |
| `helpers.ts` / `index.ts` | expose snapshot+ref-consuming helpers to agent scripts, incl. `page.locator` facade | `helpers.ts:83-89,560-602`, `index.ts:76-139` |

### Outbound (consume resolved targets)
| Consumer | How | Ref |
|---|---|---|
| `pointer.ts` click/dblclick/hover/drag/scroll | `elementCenter` click point + `DOM.dispatchMouseEvent` | `pointer.ts:63-95,602-654` |
| `keyboard.ts` focus/fill/check/selectOption/dispatchEvent | `resolveAndCall` / `withHandle` on objectId | `keyboard.ts:270-523` |
| `locator.ts` reads + `count()` + `evaluateAll` | `resolveHandle`/`resolveAndCall`; role locators → `queryRoleLocatorBackendNodeIds` | `locator.ts:219-302,322-374` |
| `waits.ts` waitForSelector | polls `resolveHandle`; retry on `transient` | `waits.ts:491-532` |
| `files.ts` setInputFiles | `withHandle` → `DOM.setFileInputFiles` | `files.ts:12` |
| `learning/validate-learning-format.ts` | rejects ``@N``/`ref=N` in durable site skills (refs are ephemeral) | `validate-learning-format.ts:12,227-236` |
| tasks/task-spaces | no direct ref use; session invalidate on task switch (`wrapInvalidating`) forces ref re-snapshot in next round | `index.ts:281-301` |

## 5. Impact analysis

- **Single choke point:** every agent element interaction — click, hover, fill, read, count, wait, upload — reduces to `resolveElementCenter` (coordinate) or `resolveElementObjectId` (handle). The `transient`/`permanent` classification *is* the contract that all retry loops (`waits.ts:505`, `locator.ts:310-317`, `readOptionalElement` fallbacks) are built on; changing it silently breaks polling semantics.
- **Correctness guards in the resolver:**
  - Degenerate box models throw `transient` rather than emitting (0,0) — a past bug (clicking the viewport corner) with a regression test (`element-resolver.test.mjs:47-74`).
  - A ref whose node errored on `getBoxModel`/`resolveNode` falls back to role/name AX re-lookup (`element-resolver.ts:100-118,182-209`) — bounded staleness recovery without re-snapshotting.
  - A *real* `ElementResolutionError` from a degenerate box model in the fallback is re-thrown, not swallowed, so the role/name re-lookup can't silently target a different same-labeled node (`element-resolver.ts:93-99`, test `element-resolver.test.mjs:70-73`).
  - Ambiguous (multi-match) and malformed selectors are `permanent` — wait loops fail loud instead of busy-looping (`waits.ts:509`).
- **Cross-round usability by design:** heredocs run in short-lived processes; a fresh process starts with an empty `browserRefMap`, and ``@N`` usage triggers `ensureRefMapForRef` → automatic `snapshotRaw` → refs work across rounds (documented in `AGENTS.md` and `SKILL.md:201`). Within a round the map mirrors only the *latest* snapshot, so `scope:'only_within_viewport'` or DOM re-renders invalidate refs by design.
- **Learning system coupling:** stable site skills must NOT embed ephemeral refs — validation rejects them so learnings can only rely on durable `loc=`/CSS (`validate-learning-format.ts:227-236`).

## 6. Gotchas / quirks found

1. **`ensureRefMapForRef` only fires on an entirely empty map** (`ref-state.ts:16`). If the map is non-empty but lacks the requested ref (e.g. the last snapshot was scoped differently), no re-snapshot happens — the ref throws `Unknown ref` `transient` and a `waitForSelector` would poll the *same* stale map until timeout rather than refresh it. Agents must re-snapshot manually.
2. **Refs are un-prefixed numeric strings in the RefMap**, and `parseRef` accepts bare digits (`ref-map.ts:50`). A selector string that is purely numeric (rare, but legal CSS like `3d` is not; pure digits aren't valid CSS anyway) would be misread as a ref.
3. **Snapshot refs never carry `frameId` or `nth`**: `browserSnapshotRefsToRefMap` calls `add()` → `addWithFrame(..., undefined)` (`browser-runtime.ts:318-324`). `addWithFrame` exists but has **zero call sites** in the whole `src/` tree — iframe-aware ref lookup is latent/dead code. Every snapshot ref therefore resolves against the default top-frame session, and its role/name fallback always picks the *first* AX match (nth defaults to 0, `element-resolver.ts:413`).
4. **`iframeSessions` is always the default `new Map()`** at real call sites (`elementCenter`/`resolveHandle` never pass one) — the `resolveFrameSession`/`resolveAxSession` branches are effectively unreachable in production flows.
5. **The raw-selector path throws for multi-matches** via `buildFindElementJs`'s `elements.length > 1` guard (`element-resolver.ts:505-512`), and `matchCountKind` maps `matched N` (N>1) → `permanent`. But the *locator* path pre-counts (`locatorCount`, `element-resolver.ts:336-354`) so a zero-match locator is `transient` and a multi-match is `permanent` — two slightly different code paths with equivalent outcome.
6. **Role resolution has two divergent engines**: refs and `loc=role:` use the *real* CDP AX tree (`Accessibility.getFullAXTree`, `element-resolver.ts:424-467`); the generic `queryAllExpression` role path (`locator-query.ts:358-405`) uses a hand-rolled DOM/AX *approximation* (implicit-role table + accessibleName heuristic). The same `loc=role:button[name="X"]` can behave differently depending on whether it flows through the AX path or the queryAll path (e.g. `count()`, `evaluateAll`, `allInnerTexts` use queryAll; clicks use AX).
7. **AX nodes without a `backendDOMNodeId` hard-fail as `permanent`** (`element-resolver.ts:458-463`) — won't heal by retry.
8. **`boxModelCenter` needs ≥8 content coords**; elements that are 0×0/display:none/not-rendered surface as `transient` "no box model", which `readOptionalElement` turns into `false`/`null` read fallbacks — visibility/state helpers silently return "absent" instead of throwing.
9. **Object handles live in `objectGroup: "ego-browser"`** (`element-resolver.ts:174,198,324`, `element-ops.ts`) and keep the wrapped elements alive in the runtime; `withHandle`/`releaseHandle` are the cleanup path, and release is best-effort (`element-ops.ts:30-37`). Unreleased handles can leak DOM nodes in long-lived sessions.
10. **`page.locator(...)` factories are synchronous** (`index.ts:40-61` — `SYNC_FACTORY_HELPERS`) while every *action* they produce is async and goes through the same resolver; the factory itself does no resolution, so a bad selector only errors on first action, not at construction.
11. **`matchCountKind` considers `matched 1 elements` transient** (`element-resolver.ts:49`) — in practice the center/find paths only emit counts when count ≠ 1, so this is defensively dead.
12. **`:has-text()` only parses when the string ends with `)`** (`locator-query.ts:187`) — a trailing-whitespace or nested-paren case silently falls back to literal CSS.