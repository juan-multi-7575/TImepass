# dsh-timepass-gemini

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
puts the timepass Gemini browser bridge in front of the model: the agent can ask
Gemini in your real, logged-in Chrome tab, attach files, capture what the page
looks like, read the DOM, and drive the UI.

The browser side is unchanged. This package is the harness half.

| timepass gives you | this plugin gives the model |
| --- | --- |
| a CLI and an SDK | `gemini_ask` and friends, callable by an agent |
| an MCP server over stdio | native harness tools, with schemas, cards, and cancellation |
| `response.md`, `screenshot.png`, `dom-tree.json` at the project root | artifacts under `.timepass/`, returned as paths |
| one process per command | one long-lived bridge, owned by the plugin fiber |

---

## How it fits together

```
model  ->  gemini_ask (harness tool)  ->  GeminiAdapter  ->  WebSocket :9876
   ^                                        (timepass src)        |
   |                                                             v
   +-- rendered answer, artifact paths              Chrome MV3 extension
                                                         |
                                                     real Gemini tab
```

The bridge is a WebSocket **server**, which is the opposite of what plugin code
usually manages:

- it starts lazily, on the first call that needs the browser, so a host that
  never uses these tools never holds the port;
- concurrent calls share one in-flight connect rather than racing two servers
  onto `ws://127.0.0.1:9876`;
- a failed connect closes the half-open server, because a driver that timed out
  still holds the port and the next attempt would fail with `EADDRINUSE`;
- disposing the plugin fiber releases the port, so a hot reload does not leave
  the browser orphaned;
- every failure is rewritten into an instruction, because the model reading the
  error cannot see your browser:

  > The timepass Chrome extension is not connected to ws://127.0.0.1:9876.
  > Open chrome://extensions, turn on Developer mode, click "Load unpacked" and
  > pick the timepass/extension directory, then keep a gemini.google.com tab
  > open and retry.

## Tools

| Tool | What it does |
| --- | --- |
| `gemini_status` | Bridge and extension health, artifact directories. `probe: true` sends a real round trip. |
| `gemini_ask` | Send a prompt, wait for the complete answer. |
| `gemini_ask_with_files` | Attach local files, verify the upload, then ask. |
| `gemini_screenshot` | Capture the Gemini viewport to a PNG and return its path. |
| `gemini_dom_snapshot` | Serialized outline: tags, attributes, visibility, geometry. `maxDepth` prunes it. |
| `gemini_page_info` | URL, title, file inputs, drop zones, button count. |
| `gemini_tabs` | Open Gemini tabs with id, title, URL, active flag, tab group. |
| `gemini_history` | Recent conversations from the sidebar. |
| `gemini_open_chat` | Switch back to a conversation by title or URL. |
| `gemini_click` | Click a CSS selector, after learning it from a fresh outline. |
| `gemini_cookies_backup` | Write session cookies to a file. **Opt-in.** |
| `gemini_cookies_restore` | Clear a domain's cookies and restore a backup. **Opt-in.** |

Plus the `/gemini` slash command, which prints the same status without spending
a model turn (`/gemini probe` re-checks the extension).

Two deliberate limits, both because this drives a human-visible browser:

- **Answers are bounded.** Past `maxResponseChars` the model gets the head of
  the answer and a path to the full text, instead of a context-filling wall of
  Markdown. Same for DOM outlines past `maxJsonChars`.
- **Cookie tools are off by default.** They move live credentials on and off the
  machine. Enable them per profile when you actually want that.

## Install

The plugin is a bundle: a package that ships a configuration layer. From the
directory that holds this one:

```sh
dsh plugin --profile <profile> add ./dsh-plugin
dsh --profile <profile> --dump-config   # shows a "# == dsh-timepass-gemini" layer
dsh --profile <profile>
```

For a source launch instead, point a patch row straight at the entry module
(the path resolves against the patch file, so an absolute one is least
surprising):

```yaml
- name: '/home/you/personal/timepass/dsh-plugin/src/index.js'
```

Two prerequisites, both about how the harness process is started:

1. The adapter is imported from `timepass/src` when the process runs under
   **tsx** (what a source launch, and `dsh` from a checkout, use) and from
   `timepass/dist` otherwise. If you use the compiled copy, run
   `npm run build` in the timepass project first.
2. Load the Chrome extension once: `chrome://extensions` -> Developer mode ->
   Load unpacked -> `timepass/extension`. Keep a `gemini.google.com` tab open.

## Configuration

Every field has a default, so the row needs no `config` block. Override by row
id in the profile's own `cordis.patch.yml`, restating the whole config:

```yaml
- id: timepass-gemini
  config:
    model: 'pro'
    timeoutMs: 180000
    maxResponseChars: 20000
    enableCookieTools: false
    verbose: true
```

| Field | Default | Meaning |
| --- | --- | --- |
| `model` | `'flash'` | Model id passed to the adapter. The extension currently ignores the model switch while it iterates on response detection, so this is a declared default, not a guarantee. |
| `timeoutMs` | `120000` | How long one ask waits for a complete turn. |
| `connectTimeoutMs` | `10000` | How long the first call waits for the extension to dial in. |
| `extensionWaitMs` | `20000` | How long a call waits for the extension to come back after a disconnect. |
| `maxResponseChars` | `12000` | Characters of an answer returned inline before it spills to a file. |
| `maxJsonChars` | `16000` | Characters of a DOM outline returned inline before it spills to a file. |
| `screenshotDir` | `.timepass/screenshots` | Where PNGs are written; relative paths resolve against `projectRoot`. |
| `transcriptDir` | `.timepass/transcripts` | Where full answers, outlines, and cookie backups are written. |
| `projectRoot` | the timepass project | What relative artifact paths resolve against. |
| `enableCookieTools` | `false` | Register the two cookie tools. |
| `verbose` | `false` | Log bridge lifecycle transitions to the host console. |

The port is deliberately **not** a field: `9876` is a contract between
`extension/background.js` (`WS_PORT`) and `ExtensionDriver`. `gemini_status`
reports the port the live driver is actually using.

## Develop

Unit tests run with the project's own suite, because the pure helpers are the
part most worth pinning down (depth pruning, text bounding, path safety,
artifact writes):

```sh
cd timepass && npm test        # project suite + the plugin's pure-helper tests
cd timepass && npm run dsh:check   # every plugin module parses and resolves
```

The plugin is plain ESM JavaScript on purpose: a bundle that needs no build
step loads under any harness runtime, source or packaged. Its contracts are
enforced where they actually matter — the tool registry validates every
argument and every canonical return value at runtime, which the scratch driver
below exercises.

The scratch driver boots the plugin in a real Cordis composition and executes
the tools. It needs the harness packages resolvable from this directory, which
is a set of symlinks rather than a dependency:

```sh
H=/path/to/deepseek-harness
mkdir -p dsh-plugin/node_modules/@deepseek-ai
ln -sfn $H/vendor/cordis                                  dsh-plugin/node_modules/@deepseek-ai/cordis
ln -sfn $H/vendor/schemastery                             dsh-plugin/node_modules/@deepseek-ai/schemastery
ln -sfn $H/vendor/cordis/node_modules/@deepseek-ai/cordis-plugin-loader  dsh-plugin/node_modules/@deepseek-ai/cordis-plugin-loader
ln -sfn $H/vendor/cordis/node_modules/@deepseek-ai/cordis-plugin-include dsh-plugin/node_modules/@deepseek-ai/cordis-plugin-include
ln -sfn $H/packages/llm/llm                              dsh-plugin/node_modules/@deepseek-ai/dsh-llm
ln -sfn $H/packages/core/tools                            dsh-plugin/node_modules/@deepseek-ai/dsh-tools
ln -sfn $H/packages/interaction/commands                  dsh-plugin/node_modules/@deepseek-ai/dsh-commands
ln -sfn $H/packages/core/system-prompt                    dsh-plugin/node_modules/@deepseek-ai/dsh-system-prompt

node dsh-plugin/scratch/driver.mjs          # no browser: registration, status, the no-extension error
node dsh-plugin/scratch/driver.mjs --fake   # a stand-in extension answers every action
```

`--fake` runs `scratch/fake-extension.mjs`, a plain WebSocket client that
speaks the same protocol as the real service worker. It is the reason the plugin
can be verified end to end without a browser: a capture really writes a PNG, a
long answer really spills to disk, and the depth bound really prunes.

## Layout

```
dsh-plugin/
├── package.json          bundle manifest (dsh.bundle.patch)
├── cordis.patch.yml      the one plugin row this bundle contributes
├── src/
│   ├── index.js          the exports Cordis reads: name, inject, apply, Config
│   ├── tools.js          the gemini_* tools, the /gemini command, apply()
│   ├── bridge.js         connect / reconnect / dispose, and the error language
│   ├── adapter-loader.js finds GeminiAdapter in src/ or dist/
│   ├── config.js         the Schemastery config schema
│   └── lib/              pure helpers + their tests (no harness imports)
└── scratch/
    ├── cordis.yml        a minimal composition for development
    ├── driver.mjs        boots it and calls the tools
    └── fake-extension.mjs  a browser-free stand-in for the Chrome extension
```

`src/lib` imports nothing from the harness, which is what keeps those tests
runnable with the project's plain `vitest`.
