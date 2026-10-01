# Troubleshooting

## Read the error string first

It tells you which code is actually running. The extension and the host plugin
update independently, so a stale one produces errors whose exact wording
predates the fix. If the wording matches an entry below's "current" text, that
layer is stale and no amount of retrying will help.

---

## The reload runbook — do this after ANY extension or plugin change

Three processes load this code independently, and **none of them notices an edit
on its own**. A test or retest run against any of them can silently exercise
code that is not the code you are reading, which is worse than a failure because
it looks like a result.

| What you changed | What you must do |
|---|---|
| `extension/*.js`, `extension/manifest.json` | Reload the extension: `chrome://extensions` → **Timepass Gemini Extension** → **Reload**. Then refresh the open `gemini.google.com` tab so the content script is re-injected. |
| `dsh-plugin/src/**` | Restart the DSH session (or toggle `timepass-gemini` off/on in the plugin manager). A running session keeps the old tool registry and the old schemas. |
| `src/**` | Restart the DSH session **and** reload the extension. The adapter is loaded host-side but the protocol it speaks is the extension's. |
| Anything at all, when the harness is **not** running under `tsx` | Run `npm run build` in the timepass project. The plugin prefers `src/index.ts`, which only a tsx-capable runtime can import; otherwise it loads `dist/`, which is gitignored — so `git status` will not show it and your edits will look applied while the old build runs. |

The `dist/` case is the quietest staleness of the lot: a stale build that
leaves no trace in version control, produces no warning, and is simply what the
plugin runs.

Why the extension needs an explicit reload: Chrome keeps a manifest V3 service
worker in memory. Editing `background.js` on disk does nothing to the worker that
is already running — it keeps executing the previous script, including its old
dispatch table, until the extension is reloaded. A terminated worker that is
woken again is re-created from the same cached script, not from your edit.

**Confirm rather than assume.** `gemini_status` now reports it:

- `builds.match: 'match'` — the running extension reports the same
  `version` as `extension/manifest.json` on disk.
- `builds.match: 'mismatch'` — it does not. Reload it.
- `builds.match: 'unknown'` — it never identified itself. Either it predates the
  handshake or the worker is stale; reload and re-check.
- `builds.missingActions` — actions this bridge sends that the extension does
  not handle. This catches a stale worker **even when nobody bumped
  `version`**, which is the case that actually bites.
- `builds.diagnostics` — every finding recorded so far, each naming what is
  wrong and how to fix it.

If `extension/` was changed, also bump `version` in `extension/manifest.json`;
the build comparison is only as good as that number.

---

## A tool is registered but the model cannot call it

**Symptom:** the plugin source has the tool, the adapter implements its method,
but the tool is absent from the session's tool list — or calling it errors with
something that makes no sense.

**Cause:** the DSH session started before the tool was added and still holds the
old tool registry. Nothing reports this, which is why `gemini_status` now
carries a `registry` block comparing registered tools against the adapter
methods they call.

**Fix:** restart the DSH session. The audit names the exact tool and method when
one is missing, e.g. `gemini_collect -> collectLastResponse`.

---

## `turnComplete` / "ANSWER IS LOST" diagnostics

`gemini_status` reports `builds.diagnostics` with `kind:
envelope-non-conformant` when a reply looks like a completed answer but omits
`turnComplete`. The message says whether the answer still reached the caller
("delivered anyway") or was dropped ("THE ANSWER IS LOST"), and names the action.

This is the runtime guard for `CompletedAnswerEnvelope` in
`src/adapter/types.ts`: the extension is plain JavaScript, so no build step can
force a producer to set the field. The host tolerates the omission and still
returns the answer, but says so out loud rather than passing silently.

---

## `tool "gemini_ask" returned invalid output: "value.X" is not a declared property (additionalProperties: false)`

**Cause:** the DSH host has a stale copy of the plugin module. The tool's output
schema and its actual output have drifted apart.

**Fix:** remount the plugin through the plugin manager (toggle
`timepass-gemini` off, then on).

**Do not** try to fix it by editing `~/.dsh/profiles/web/cordis.patch.yml` and
waiting. An older comment in that file claims editing it re-applies the patch;
as of 2026-09-28 that is not what happens — no re-apply occurred after 45
seconds, and the extension's "connected since" timestamp never changed. Toggling
the plugin is what actually rebuilds the bridge.

After a remount the extension reconnects on its own backoff loop, so wait a few
seconds before the next call.

---

## `Element removed from DOM during typing` (or any stale-`content.js` wording)

**Cause:** the content script injected into the Gemini tab predates the current
`extension/content.js`.

**Fix:** reload the extension at `chrome://extensions`, then refresh the Gemini
tab.

**Why a normal retry never helps:** the extension only re-injects
`content.js` when the content script is *absent* (a "receiving end does not
exist" error). A script that is present but stale is never replaced. Reloading
the extension is the only path that swaps it.

**Confirming which build is live:** the error text differs between versions. A
message that still mentions the old wording proves the tab is on the old build.

---

## Bridge reports `ready` but the extension is not connected

`gemini_status` separates the two. The bridge listening means only that port
9876 is bound; the extension must separately dial in.

If nothing is connected, check:

1. The extension is loaded in `chrome://extensions` and enabled.
2. A Gemini tab is open (`gemini_tabs` is the check — it needs the extension too,
   so check in Chrome directly).
3. Port 9876 is not held by a stale process. A previous bridge that was not
   disposed cleanly keeps the port, and the new one fails to bind.

The extension retries on an exponential backoff, so a bridge that comes back is
usually picked up within seconds.

---

## An answer came back short but not marked `partial`

Check `elapsedMs` against the time the task should have taken. If the turn hit
the configured `timeoutMs` but the flag did not survive, the host plugin is
stale — the `partial` field is the newest part of the output schema.

---

## `partial: true` on a long answer

Not a bug. The turn outran `timeoutMs` (default 120000). Re-ask with a larger
budget, or pass `saveTo` and read the artifact.

Raising the timeout and retrying is the only fix. Retrying at the same value
truncates identically.

---

## A click had no effect

Gemini rebuilds its DOM constantly. Take a fresh `gemini_dom_snapshot` and read
the selector off the current tree rather than reusing one from earlier in the
session.

---

## The tab is on a consent wall or a login page

`gemini_page_info` returns the URL and title. If the URL is not a normal Gemini
app page, every other tool will fail in confusing ways. Resolve that first.

`gemini_session` reports this as `kind: nonChat`, which is the cheaper way to
find out.

---

## The answer came from the wrong conversation

The agent asked into a tab the user was not looking at, or into a conversation
that had since changed. This is silent — the answer looks right, it is just not
the answer to the question that was meant.

`gemini_session` reports `kind: existing` plus the `sessionConversationId` that
`gemini_ask` records on its reply. Compare that id to the conversation the user
named. If they differ, switch with `gemini_open_chat` and re-check before
asking again.

`gemini_session(wantNew: true)` opens a new tab, because `newChat` is not yet
wired through to the open tab — so passing `newChat: true` into `gemini_ask`
does not start a fresh conversation.
