---
name: timepass-gemini
description: Ask Gemini in the operator's real Chrome tab through the timepass bridge (gemini_* tools). Use for long-form answers, the user's logged-in Gemini session, reasoning over a document or image open in a tab, and any prompt phrased as "ask Gemini" or "use my Gemini". Not for general facts (use web search) or fetching a known URL (use web_fetch).
---

# timepass Gemini Bridge

Drives Gemini in the user's own Chrome tab over a local WebSocket bridge
(`127.0.0.1:9876`). It is slower and more observable than a web search because
it is a real browser session — use it when the user's session *is* the
requirement.

## When NOT to use this

| Need | Use instead |
|---|---|
| A fact, current news, a general question | `web_search` |
| A specific known URL | `web_fetch` |
| Code work in this repo | Read the files |
| Anything not already reasoned about above | Ask before burning a browser round trip |

This bridge is for when the answer must come from *Gemini specifically* — the
logged-in session, the user's own conversation history, or an attachment.

## Preflight: check the session before the first ask

```
gemini_session()
```

Read the reply. It must report `kind: new` or `kind: existing` with `ok: true`
before you ask. This is the check the agent routinely skips:

- **`none`** — no Gemini tab is open. `gemini_ask` opens one itself, but you
  will not know which conversation it landed in. Call `gemini_session(ensure: true)`
  to open one explicitly and get its identity back.
- **`nonChat`** — the tab is on a sign-in or consent page. Nothing you ask will
  answer. Complete it in the browser, then re-check.
- **`new`** — a fresh empty conversation. Your ask starts it.
- **`existing`** — a conversation with an id. Your ask continues it. If the user
  named a different conversation, switch with `gemini_open_chat` first.

If you are not sure which tab is active, call this before asking — it costs one
cheap round trip and prevents asking into the wrong thread.

`gemini_ask` and `gemini_ask_with_files` also record the session they spoke into
on the reply (`sessionKind`, `sessionUrl`, `sessionConversationId`), so the
verdict survives the round trip. A reply from `nonChat` means the tab was on a
sign-in wall, and a reply from `existing` means it continued a conversation the
user may not have meant.

If the extension is missing: it is a Chrome extension that must be loaded in
`chrome://extensions`, and the Gemini tab must be open. See
`references/troubleshooting.md`.

## Which build are you talking to?

`gemini_status` reports a `builds` block, and it is the difference between
trusting a result and not:

```
builds.match === 'match'      the extension is the code on disk
builds.match === 'mismatch'   it is not — every result this session is suspect
builds.match === 'unknown'    it never identified itself; usually the same thing
```

`mismatch` and `unknown` mean the browser is running older code than the files
you are reading, so a bug you "fixed" may never have run and a bug you
"reproduced" may be gone. **Do not chase results until this reads `match`** —
reload the extension at `chrome://extensions` → Reload, and restart the DSH
session if the tool list itself looks wrong.

`builds.missingActions` names actions the extension cannot handle, which is how
a stale service worker is detected even when no version was bumped.

## The answer contract — read this before reporting any answer

Every ask returns flags. They are not decoration; two of them change what you
are allowed to say.

| Flag | Meaning | What you may do |
|---|---|---|
| `partial: true` | **The turn timed out mid-answer.** The text is a fragment and the response continues past it. | Never present it as the full answer. Call `gemini_collect` **first** — the turn usually finished after the host gave up. Re-ask only if the collect finds nothing, and then with a larger `timeoutMs`. |
| `truncated: true` | Only a *display* bound was hit. | Harmless. The complete answer is at `savedTo`; read that file if you need the rest. |
| `recovered: true` | The answer was re-read from Gemini's saved conversation — after a tab freeze, or collected after a timeout. | Harmless and complete. Check `recoveredFrom` if you need to know which. |

`partial` and `truncated` are unrelated and demand opposite responses. A
partial answer is also usually `truncated` false — it is short because it
stopped, not because it was bounded.

The rendered text carries an `[INCOMPLETE ANSWER]` banner when `partial` is
set. Never strip it and never paper over it.

## Timeouts

`timeoutMs` is the budget for the **whole turn**, not per phase (default 120000).
A long response that returns `partial: true` is nearly always this being too
small. When a task needs a genuinely long answer, raise it up front:

```
gemini_ask(query: "...", timeoutMs: 300000)
```

Do not retry a partial answer at the same timeout — it will truncate identically.
Do not retry it *at all* until you have tried `gemini_collect`: a timed-out turn
is usually a finished turn the host stopped waiting for, and collecting it costs
one cheap call instead of the whole reasoning budget again.

```
gemini_ask(query: "...", timeoutMs: 60000)   # returns partial: true
gemini_collect()                             # the finished answer, source: late-reply
```

## Model

Defaults to `flash`. Pass `model` only when the task calls for it; the
extension currently does not switch models reliably, so treat it as a
declaration rather than a guarantee.

## Reference router

- `references/tools.md` — all fourteen `gemini_*` tools and the `/gemini` command
- `references/troubleshooting.md` — error strings, what causes them, what fixes them
- `references/patterns.md` — worked shapes for common tasks

## Rules

- Probe before the first ask in a session that will use the bridge.
- **Check the session before asking.** Run `gemini_session()` first. If it reports
  `none` or `nonChat`, do not ask. If it reports `existing`, confirm it is the
  conversation the user meant.
- Never report a `partial` answer as complete.
- Prefer `saveTo` for answers you expect to be long; you get the path back
  without flooding context.
- The browser tab is visible to the user. Anything you do there, they can watch.
