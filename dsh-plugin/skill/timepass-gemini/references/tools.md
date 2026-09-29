# gemini_* tool map

Thirteen tools plus one slash command. All of them talk to the same bridge; only
`gemini_status` and `gemini_ask*` are needed for most work.

## Asking

### `gemini_ask`
Send a prompt, wait for the turn to finish, return the answer.

| Param | Notes |
|---|---|
| `query` | required |
| `model` | defaults to `flash` |
| `newChat` | start a fresh conversation instead of continuing the open one |
| `timeoutMs` | budget for the **whole** turn, default 120000 |
| `saveTo` | also write the complete answer to this path |

Returns `chatId`, `text`, `chars`, `truncated`, `partial`, `recovered`, `model`,
`elapsedMs`, `savedTo`, plus a **session identity**:

| Field | Notes |
|---|---|
| `sessionKind` | `none`, `nonChat`, `new`, or `existing` — which session the ask was sent into |
| `sessionUrl` | URL of the tab it was sent into |
| `sessionConversationId` | The conversation id from that URL, or empty for a fresh chat |

Read the flag table in `SKILL.md` before using the text. `sessionKind` is
recorded on every reply so the agent cannot lose it between the preflight and
the answer: a reply from `nonChat` means the tab was on a sign-in or consent
wall, and `existing` means the ask continued a conversation the user may not
have meant.

### `gemini_ask_with_files`
Attach local files, verify the upload, then send one prompt — atomically.
Files are uploaded one at a time and checked before the prompt goes out, so a
partial upload fails the call instead of producing a quietly wrong answer.

| Param | Notes |
|---|---|
| `query` | required |
| `files` | required; absolute or project-relative paths |
| `model`, `newChat`, `timeoutMs`, `saveTo` | as above |

Use this for a document, PDF, image, or CSV Gemini must read.

## Inspecting

### `gemini_status`
`probe: true` sends a real round trip. Reports bridge state (`idle`,
`connecting`, `ready`, `error`, `disposed`), whether the extension is connected,
port, and `lastError`. Cheap — call it first.

### `gemini_session`
**Inspect, and if asked open, the session the agent will work in.**

Use this before any ask when the user named a conversation, or when you are not
sure which tab is active. It does not ask Gemini anything — it only reports
which conversation is open and, with `ensure: true`, opens one if none is.

| Param | Notes |
|---|---|
| `ensure` | Open a Gemini tab if none is open (default false, so this never opens a tab unless asked) |
| `wantNew` | Open a new tab, because `newChat` is not wired through to the open tab |

Returns `kind`, `url`, `conversationId`, `tabCount`, `opened`, `ok`, `guidance`.

`kind` is one of:

| kind | Meaning |
|---|---|
| `none` | No Gemini tab is open |
| `nonChat` | The open tab is on a sign-in or consent page, not a conversation |
| `new` | A fresh empty conversation |
| `existing` | A conversation with an id in its URL |

`ok` is `true` only for `new` and `existing`. `guidance` says plainly what to do
next, so the verdict does not depend on the agent remembering the rule.

### `gemini_page_info`
URL, title, file input count, drop zones, button count. Useful to confirm the
tab is on a real page rather than a consent wall or login screen.

### `gemini_dom_snapshot`
Serialized outline of the page: every element with tag, classes, attributes,
visibility, and geometry. Use to discover a **real selector** before clicking.

| Param | Notes |
|---|---|
| `selector` | defaults to the whole body |
| `maxDepth` | default 6; `0` keeps only the match |
| `saveTo` | write the full outline to disk |

Bounded at 16000 chars inline; the rest goes to `savedTo`.

### `gemini_screenshot`
PNG of the viewport, window maximized and the Gemini tab focused, so the image
matches what the user sees. Takes a `label` for the filename. Use when the DOM
tools cannot describe what matters, or to show the user current state.

## Navigating

### `gemini_tabs`
Every open Gemini tab: `id`, `title`, `url`, `active`, `groupName`.

### `gemini_history`
Conversations from the sidebar, newest first by sidebar order. Takes `limit`
(default 20). Returns `title` and `url` per entry, plus `total`.

### `gemini_open_chat`
Switch to an existing conversation. Takes `match` — a title substring or a URL
fragment. Returns the resulting `url`.

## Acting

### `gemini_click`
Click a CSS `selector`. Returns what the page reported afterwards.

Always derive the selector from a fresh `gemini_dom_snapshot`. Gemini rebuilds
its DOM constantly, so a selector captured earlier is often stale — this is the
single most common cause of a click that silently does nothing.

## Session

### `gemini_cookies_backup`
Save cookies for a `domain` (default `gemini.google.com`) to JSON. Takes
`saveTo`; otherwise it lands in the transcript directory. Returns `count` and
`savedTo`.

### `gemini_cookies_restore`
Restore from a backup `file` for a `domain`. Returns `count` and `savedTo`.

Use around anything that disturbs the logged-in session.

## Slash command

`/gemini` — reports bridge status. Add the word `probe` to force a live check:
`/gemini probe`.

## Configuration defaults

From the plugin's `config` schema; a profile may override them.

| Key | Default | Meaning |
|---|---|---|
| `model` | `flash` | model id per ask |
| `timeoutMs` | `120000` | budget for one whole turn |
| `connectTimeoutMs` | `10000` | wait for the extension to dial the bridge |
| `extensionWaitMs` | `20000` | wait for it to dial back after a disconnect |
| `maxResponseChars` | `12000` | answer chars returned inline before spilling to disk |
| `maxJsonChars` | `16000` | DOM outline chars returned inline |
| `screenshotDir` | `.timepass/screenshots` | where PNGs go |
| `transcriptDir` | `.timepass/transcripts` | where spilled answers go |

## Headless CLI

The same engine is available outside a session as `timepass ask|stream ...`.
It is a separate surface and is not covered by this skill; reach for it in CI
or scripting, not for interactive work.
