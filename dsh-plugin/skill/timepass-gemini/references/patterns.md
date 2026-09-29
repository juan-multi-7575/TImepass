# Patterns

Worked shapes for the tasks that come up most. Each one is a sequence, not a
recipe to copy verbatim.

## One long-form answer

```
gemini_status(probe: true)          # once per session
gemini_ask(query, timeoutMs: 300000, saveTo: "...")
```

Raise the timeout *before* the first attempt when the answer is expected to be
long. A `partial` result is not a smaller answer, it is a prefix — retrying it
at the same budget gives the same prefix.

`saveTo` gives you the full text on disk without pushing it all through context.
Read the file if you need the tail.

## Reason over a document

```
gemini_ask_with_files(
  query: "Summarise the argument structure and flag any claim you cannot support from the text.",
  files: ["docs/spec.md"],
  saveTo: "analysis.md"
)
```

Upload and prompt are one atomic call, so a silently failed attachment cannot
produce a confident wrong answer. Ask for claims traceable to the text — it
makes hallucination visible instead of plausible.

## Continue an existing conversation

```
gemini_history(limit: 10)
gemini_open_chat(match: "quarterly review")
gemini_ask(query: "...", newChat: false)
```

`gemini_open_chat` matches a title substring or URL fragment. Omit `newChat` so
the follow-up lands in the conversation you just opened.

## Iterate on a long answer

Ask in rounds against the same conversation rather than re-asking from scratch:

1. First ask for the full answer with `saveTo`.
2. Read the file.
3. `gemini_ask` a targeted follow-up ("expand section 3", "tighten the summary").

Cheaper, and the model keeps the context you already paid for.

## Inspect the page before acting

```
gemini_page_info()
gemini_dom_snapshot(selector: "response-container", maxDepth: 8)
gemini_click(selector: "<selector read off the snapshot>")
gemini_screenshot(label: "after-click")
```

The snapshot is the step people skip. A selector from earlier in the session is
usually stale by the time you use it.

## Show the user what the tab looks like

```
gemini_screenshot(label: "gemini-state")
```

Maximizes the window and focuses the Gemini tab, so the image matches what the
user sees rather than some background tab. Reach for this when the question is
about visual state and no DOM query will do.

## Save and restore the session

```
gemini_cookies_backup(saveTo: "gemini-session.json")
# ... work that disturbs the session ...
gemini_cookies_restore(file: "gemini-session.json")
```

Useful around anything that may log the session out.

## Many tabs

```
gemini_tabs()
gemini_open_chat(match: "<title or url fragment>")
```

The tools act on the open conversation, so a stray tab silently answers the
wrong question. When `gemini_tabs` shows more than one, establish which
conversation you are in before asking.
