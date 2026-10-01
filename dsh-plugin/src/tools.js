import { defineTool } from '@deepseek-ai/dsh-tools'
import { createBridge } from './bridge.js'
import { BRIDGE_PORT, Config, normalizeConfig } from './config.js'
import { readJsonFile, writeArtifact } from './lib/artifacts.js'
import { artifactPath, resolveOutputPath, slugify } from './lib/paths.js'
import { boundText, formatBytes, summarize } from './lib/text.js'
import { countNodes, countVisibleNodes, pruneTree } from './lib/tree.js'
import { sessionGuidance, sessionKind, conversationIdFromUrl, sessionOk } from './lib/session.js'
import { auditToolRegistry, describeRegistryAudit } from './lib/registry.js'
import { loadGeminiAdapter } from './adapter-loader.js'

/**
 * The timepass Gemini bridge as model-facing harness tools.
 *
 * One plugin fiber owns one `gemini_*` tool family plus the `/gemini` command,
 * and exactly one WebSocket bridge between them: the browser is a single
 * shared resource, so every tool goes through {@link createBridge} rather than
 * opening its own connection.
 * @module dsh-timepass-gemini/tools
 */

export { Config }

export const name = 'timepass-gemini'
export const inject = ['tools', 'commands']

/** Domain used when a cookie tool is called without one. */
const DEFAULT_COOKIE_DOMAIN = 'gemini.google.com'

/** Page used when the bridge opens a tab of its own. */
const DEFAULT_GEMINI_URL = 'https://gemini.google.com/app'

/**
 * The URL prefix that identifies a conversation page, as opposed to a sign-in,
 * consent, or redirected page.
 *
 * Kept here so the tool code can reference it without importing; the
 * classification itself lives in `lib/session.js`, which is pure and therefore
 * unit-testable.
 */
const APP_PREFIX = 'https://gemini.google.com/app'

// Re-export the pure session helpers so callers that already import this module
// can reach them; the definitions and their tests live in lib/session.js.
export { sessionGuidance, sessionKind, conversationIdFromUrl, sessionOk }

/**
 * Drop keys whose value is `undefined`, so an optional canonical field is
 * absent rather than present-and-empty.
 *
 * @param {Record<string, unknown>} value - The object to compact.
 * @returns {Record<string, unknown>} A copy without the undefined entries.
 */
function compact(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out
}

/**
 * Reject a blank string the schema is happy with but the browser is not.
 *
 * @param {unknown} value - The model-supplied string.
 * @param {string} field - The field name, for the error message.
 * @returns {string} The trimmed value.
 */
function requireText(value, field) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length === 0) throw new Error(field + ' must not be empty')
  return text
}

/**
 * Reject a model-supplied list that holds no usable path.
 *
 * @param {unknown} value - The model-supplied array.
 * @param {string} field - The field name, for the error message.
 * @returns {string[]} The list, with every entry trimmed.
 */
function requireList(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(field + ' must list at least one file path')
  }
  return value.map((entry, index) => requireText(entry, field + '[' + index + ']'))
}

/**
 * The canonical `gemini_status` value, shared by the tool and the command so
 * both report the same facts in the same shape.
 *
 * @param {Record<string, any>} snapshot - The bridge snapshot.
 * @param {boolean} probed - Whether a real round trip refreshed the snapshot.
 * @returns {Record<string, unknown>} The canonical status value.
 */
function statusValue(snapshot, probed) {
  return compact({
    state: snapshot.state,
    extension: snapshot.extensionConnected === true
      ? 'connected'
      : snapshot.extensionConnected === false ? 'disconnected' : 'unknown',
    port: snapshot.port,
    // Build identity and every contract finding, so a status call answers
    // "which build am I actually talking to" and not only "is it up".
    builds: snapshot.bridge ? buildValue(snapshot.bridge) : undefined,
    registry: snapshot.registry,
    model: snapshot.model,
    probed,
    connectedAt: snapshot.connectedAt ?? undefined,
    adapterFrom: snapshot.adapterFrom ?? undefined,
    lastError: snapshot.lastError ?? undefined,
    screenshotDir: snapshot.screenshotDir,
    transcriptDir: snapshot.transcriptDir,
    cookieToolsEnabled: snapshot.cookieToolsEnabled,
  })
}

/**
 * The build half of a status value, flattened to primitives.
 *
 * @param {Record<string, any>} info - The driver's bridge info.
 * @returns {Record<string, unknown>} Build facts that survive a JSON schema.
 */
function buildValue(info) {
  return compact({
    driverBuildId: info.driverBuildId,
    expectedExtensionBuildId: info.build?.expectedBuildId,
    extensionBuildId: info.extensionBuildId,
    match: info.buildMatch,
    extensionSourceFingerprint: info.build?.sourceFingerprint,
    manifestPath: info.build?.manifestPath,
    missingActions: info.missingActions,
    diagnostics: info.diagnostics,
  })
}

/**
 * Render the build facts, loudly enough that a mismatch cannot be skimmed past.
 *
 * The retest these fields exist for ran a whole session against a service worker
 * that was not the code on disk, and the only symptom was a handful of results
 * that did not add up. A status call now has to say so in the first few lines.
 *
 * @param {Record<string, any>} builds - The build facts from a status value.
 * @returns {string[]} One line per fact.
 */
function buildLines(builds) {
  const lines = []
  const expected = builds.expectedExtensionBuildId
  const reported = builds.extensionBuildId
  lines.push(
    'builds: driver ' + builds.driverBuildId
    + ' | extension on disk ' + (expected ?? 'unknown')
    + ' | extension running ' + (reported ?? 'did not report')
  )
  if (builds.extensionSourceFingerprint) {
    lines.push('extension sources: ' + builds.extensionSourceFingerprint + ' (manifest ' + builds.manifestPath + ')')
  }
  if (builds.match === 'mismatch') {
    lines.push(
      'BUILD MISMATCH: the extension is running ' + reported + ' but the files on disk are ' + expected + '. '
      + 'Results from this session are NOT from the code you are reading. Reload the extension at '
      + 'chrome://extensions → Reload, then restart the DSH session.'
    )
  } else if (builds.match === 'unknown' && reported === null) {
    lines.push(
      'BUILD UNVERIFIED: the extension never identified itself. It either predates the handshake or its '
      + 'worker is running an older build than the files on disk — Chrome keeps the worker script in '
      + 'memory, so reload it at chrome://extensions → Reload before trusting these results.'
    )
  }
  if (builds.missingActions?.length) {
    lines.push(
      'STALE WORKER: the extension does not handle ' + builds.missingActions.join(', ')
      + ', which this bridge sends. Reload it at chrome://extensions → Reload.'
    )
  }
  for (const finding of builds.diagnostics ?? []) {
    lines.push('[' + finding.kind + '] ' + finding.message)
  }
  return lines
}

/**
 * Render a status value as the lines a human or a model can act on.
 *
 * @param {Record<string, any>} value - The canonical status value.
 * @returns {string[]} One line per fact.
 */
function statusLines(value) {
  const lines = [
    'bridge: ' + value.state + ' on ws://127.0.0.1:' + value.port,
    'chrome extension: ' + value.extension + (value.connectedAt ? ' (since ' + value.connectedAt + ')' : ''),
    'default model: ' + value.model,
    'artifacts: screenshots to ' + value.screenshotDir + ', transcripts to ' + value.transcriptDir,
  ]
  if (value.builds) lines.push(...buildLines(value.builds))
  if (value.registry) {
    for (const line of describeRegistryAudit(value.registry)) lines.push('tool registry: ' + line)
  }
  if (value.lastError) {
    lines.push('last error: ' + value.lastError)
  } else if (value.state === 'ready' && value.extension !== 'connected') {
    lines.push('The bridge is listening on port ' + value.port + ' but no extension has connected. Load '
      + 'timepass/extension in chrome://extensions, open a gemini.google.com tab, then re-check with probe=true.')
  } else if (value.state === 'idle') {
    lines.push('The bridge has not been used yet; it starts on the first gemini_* call that needs the browser.')
  }
  if (value.cookieToolsEnabled) lines.push('cookie tools: enabled')
  return lines
}

/**
 * Build every tool this plugin registers, in the order the model should try them.
 *
 * @param {ReturnType<typeof createBridge>} bridge - The shared bridge.
 * @param {Record<string, any>} config - Normalized plugin configuration.
 * @returns {object[]} Tool definitions ready for `defineTool`.
 */
function createTools(bridge, config) {
  const tools = []

  // ---------------------------------------------------------------- status --

  tools.push({
    name: 'gemini_status',
    description:
      'Check the timepass Gemini browser bridge: whether the local WebSocket server and the Chrome extension '
      + 'are connected, and where screenshots and transcripts are written. Call this with probe=true when a '
      + 'gemini_* tool reported the extension as missing, or before the first ask in a session.',
    parameters: {
      probe: {
        type: 'boolean',
        description: 'Send a real round trip to the extension to refresh the answer (default false reports only what this host already knows).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          state: {
            type: 'string',
            required: true,
            enum: ['idle', 'connecting', 'ready', 'error', 'disposed'],
            description: 'Bridge lifecycle state: idle (never used), connecting, ready, error, disposed.',
          },
          extension: {
            type: 'string',
            required: true,
            enum: ['connected', 'disconnected', 'unknown'],
            description: 'Whether the Chrome extension is on the bridge right now.',
          },
          port: { type: 'integer', required: true, description: 'Local WebSocket port the bridge listens on.' },
          builds: {
            type: 'object',
            // DSH's schema compiler rejects any object schema that does not
            // state this outright, so it is spelled on every nested object here.
            additionalProperties: false,
            description:
              'Which build each end of the bridge is actually running. Read this before trusting a result: '
              + 'match "mismatch" means the extension is not the code on disk, and "unknown" means it never '
              + 'said, which usually means the same thing.',
            properties: {
              driverBuildId: { type: 'string', description: 'Build id of this host driver.' },
              expectedExtensionBuildId: { type: 'string', description: 'version from extension/manifest.json on disk.' },
              extensionBuildId: { type: 'string', description: 'Build the connected extension reports at runtime.' },
              match: { type: 'string', enum: ['match', 'mismatch', 'unknown'], description: 'Whether the two agree.' },
              extensionSourceFingerprint: { type: 'string', description: 'Short digest of the extension sources on disk.' },
              manifestPath: { type: 'string', description: 'Manifest the host read the expectation from.' },
              missingActions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Actions this bridge sends that the connected extension does not handle.',
              },
              diagnostics: {
                type: 'array',
                description: 'Every skew and contract finding recorded so far, most actionable first.',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', description: 'Finding kind, e.g. build-mismatch or envelope-non-conformant.' },
                    message: { type: 'string', description: 'What is wrong and how to fix it.' },
                    at: { type: 'integer', description: 'Epoch millis the finding was recorded.' },
                  },
                },
              },
            },
          },
          registry: {
            type: 'object',
            additionalProperties: false,
            description: 'Audit of registered tools against the adapter methods they call.',
            properties: {
              ok: { type: 'boolean', description: 'Whether every registered tool has an adapter method to call.' },
              missingMethods: {
                type: 'array',
                items: { type: 'string' },
                description: 'Tool -> method pairs the loaded adapter does not satisfy.',
              },
              missingRequired: {
                type: 'array',
                items: { type: 'string' },
                description: 'Adapter methods the bridge cannot work without, and which are absent.',
              },
              unverifiedTools: {
                type: 'array',
                items: { type: 'string' },
                description: 'Registered tools with no declared adapter method, so the audit cannot vouch for them.',
              },
              unregisteredMethods: {
                type: 'array',
                items: { type: 'string' },
                description: 'Adapter methods with no tool. Informational only.',
              },
            },
          },
          model: { type: 'string', required: true, description: 'Default Gemini model id used by gemini_ask.' },
          probed: { type: 'boolean', required: true, description: 'Whether this answer came from a real round trip.' },
          connectedAt: { type: 'string', description: 'ISO instant the extension connected.' },
          adapterFrom: { type: 'string', description: 'Module the timepass adapter was imported from.' },
          lastError: { type: 'string', description: 'Most recent bridge failure, already rewritten to be actionable.' },
          screenshotDir: { type: 'string', required: true, description: 'Directory gemini_screenshot writes PNGs to.' },
          transcriptDir: { type: 'string', required: true, description: 'Directory long answers and outlines are written to.' },
          cookieToolsEnabled: { type: 'boolean', required: true, description: 'Whether the cookie tools are registered.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: statusLines(value).join('\n') }],
    },
    async execute(args) {
      const probed = args.probe === true
      const snapshot = probed ? await bridge.probe() : bridge.status()
      return statusValue(snapshot, probed)
    },
    presentCall: args => ({
      card: 'generic',
      title: args.probe === true ? 'Probe timepass bridge' : 'Check timepass bridge',
      kind: 'other',
    }),
  })

  // ------------------------------------------------------------ session --

  /**
   * Inspect, and if asked, open, the Gemini session the agent will work in.
   *
   * The agent routinely skips this check and then asks into the wrong tab:
   * a sign-in page returns no answer, a different conversation returns a reply
   * that looks right but answers the wrong thread. This tool exists so that
   * check is one call, and so its verdict is recorded on every ask result.
   *
   * It does NOT ask Gemini anything — it only reports which conversation is
   * open and, when `ensure` is set, opens one if none is.
   */
  tools.push({
    name: 'gemini_session',
    description:
      'Inspect the Gemini session: which tab is open, whether it is a real conversation or a sign-in/consent '
      + 'page, and which conversation it is. Use this before any ask when the user named a conversation, or when '
      + 'you are unsure which tab is active. With ensure: true, opens a Gemini tab if none is open.',
    parameters: {
      ensure: {
        type: 'boolean',
        description: 'Open a Gemini tab if none is open (default false, so this never opens a tab unless asked).',
      },
      wantNew: {
        type: 'boolean',
        description: 'True when the user asked for a fresh conversation. Opens a new tab, because the newChat '
          + 'flag is not yet wired through to the open tab.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            required: true,
            enum: ['none', 'nonChat', 'new', 'existing'],
            description: 'none = no Gemini tab; nonChat = a sign-in or consent page; new = a fresh empty chat; '
              + 'existing = a conversation with an id.',
          },
          url: { type: 'string', required: true, description: 'The open tab URL, or empty when none.' },
          conversationId: { type: 'string', required: true, description: 'The conversation id from the URL, or empty.' },
          tabCount: { type: 'integer', required: true, description: 'How many Gemini tabs are open.' },
          opened: { type: 'boolean', required: true, description: 'Whether this call opened a tab.' },
          ok: { type: 'boolean', required: true, description: 'Whether an ask may proceed into this session.' },
          guidance: { type: 'string', required: true, description: 'What to do next, in plain terms.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.guidance + (value.tabCount > 1
          ? '\n' + value.tabCount + ' Gemini tabs are open; gemini_ask will drive the first one.'
          : ''),
      }],
    },
    async execute(args, exec) {
      const ensure = args.ensure === true
      const wantNew = args.wantNew === true
      const tabs = await bridge.call('gemini_session', adapter => adapter.listTabs(), exec.signal)
      const list = Array.isArray(tabs) ? tabs : []

      let opened = false
      let url = list.length ? (typeof list[0]?.url === 'string' ? list[0].url : '') : ''

      if (list.length === 0) {
        if (ensure) {
          await bridge.call('gemini_session', adapter => adapter.createTab(DEFAULT_GEMINI_URL), exec.signal)
          const again = await bridge.call('gemini_session', adapter => adapter.listTabs(), exec.signal)
          const second = Array.isArray(again) ? again : []
          url = second.length ? (typeof second[0]?.url === 'string' ? second[0].url : '') : DEFAULT_GEMINI_URL
          opened = true
        }
      } else if (wantNew) {
        // newChat is not wired through to the open tab, so a fresh conversation
        // needs its own tab. The ask will pick it up as tabs[0].
        await bridge.call('gemini_session', adapter => adapter.createTab(DEFAULT_GEMINI_URL), exec.signal)
        const again = await bridge.call('gemini_session', adapter => adapter.listTabs(), exec.signal)
        const second = Array.isArray(again) ? again : []
        url = second.length ? (typeof second[0]?.url === 'string' ? second[0].url : '') : DEFAULT_GEMINI_URL
        opened = true
      }

      const kind = sessionKind(url)
      const ok = kind === 'new' || kind === 'existing'
      return {
        kind,
        url,
        conversationId: conversationIdFromUrl(url),
        tabCount: list.length,
        opened,
        ok,
        guidance: sessionGuidance({ kind, url, wantNew, opened, ok }),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.ensure === true ? 'Open Gemini session' : 'Inspect Gemini session',
      kind: 'other',
      rawInput: args,
    }),
  })

  /**
   * Shared body of the two ask tools: one adapter call, then bound the answer
   * to the configured inline budget and spill the rest to disk.
   *
   * @param {Record<string, any>} args - The validated model arguments.
   * @param {any} exec - The tool run context (cancellation signal).
   * @param {string} label - The tool name, for bridge error text.
   * @param {string[]} [files] - Files to attach before asking.
   * @returns {Promise<Record<string, unknown>>} The canonical answer value.
   */
  async function runAsk(args, exec, label, files) {
    const query = requireText(args.query, 'query')
    if (files) requireList(files, 'files')

    const model = typeof args.model === 'string' && args.model.length > 0 ? args.model : config.model
    const options = {
      model,
      newChat: args.newChat === true,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : config.timeoutMs,
    }
    const startedAt = Date.now()

    // Which conversation are we about to speak into? The ask result carries
    // the answer, so it carries this too — otherwise the check is invisible
    // once the reply is in hand and the agent cannot tell it answered the
    // wrong thread.
    const preTabs = await bridge.call(label, adapter => adapter.listTabs(), exec.signal)
    const preUrl = Array.isArray(preTabs) && preTabs.length
      ? (typeof preTabs[0]?.url === 'string' ? preTabs[0].url : '')
      : ''
    const preKind = sessionKind(preUrl)

    const response = files
      ? await bridge.call(label, adapter => adapter.askWithFiles(query, files, options), exec.signal)
      : await bridge.call(label, adapter => adapter.ask(query, options), exec.signal)

    const full = typeof response?.text === 'string' ? response.text : ''
    const bound = boundText(full, config.maxResponseChars)

    // An explicit saveTo always stores the full answer; otherwise a bounded
    // answer spills to the transcript directory so nothing is lost silently.
    const requested = resolveOutputPath(config.projectRoot, args.saveTo)
    const target = requested
      ?? (bound.truncated
        ? artifactPath(config.transcriptDir, slugify(query, 'answer'), { ext: 'md' })
        : null)
    const savedTo = target ? (await writeArtifact(target, full)).path : undefined

    return compact({
      chatId: typeof response?.chatId === 'string' ? response.chatId : '',
      text: bound.text,
      chars: bound.originalChars,
      truncated: bound.truncated,
      partial: response?.partial === true,
      recovered: response?.recovered === true,
      model,
      elapsedMs: Date.now() - startedAt,
      savedTo,
      files: files ? [...files] : undefined,
      // Session identity — recorded so the agent cannot lose it between the
      // preflight check and the reply.
      sessionKind: preKind,
      sessionUrl: preUrl || undefined,
      sessionConversationId: conversationIdFromUrl(preUrl) || undefined,
    })
  }

  /**
   * Render an ask result: the answer first, then the provenance footer.
   *
   * @param {Record<string, any>} value - The canonical answer value.
   * @returns {object[]} One text block.
   */
  function renderAnswer(value) {
    const body = value.text.trim().length > 0 ? value.text : '(Gemini returned no text for this prompt.)'
    // An unfinished answer has to say so *above* the text, not in the footer:
    // a reader has to know the content is a fragment before relying on it.
    // `chars` is the length before display bounding, which for a partial answer
    // is exactly the length of the fragment.
    const banner = value.partial
      ? '[INCOMPLETE ANSWER] Gemini had not finished when the wait timed out. Only '
        + value.chars
        + ' characters were captured and the response continues past this point. '
        + 'Do not present this as the full answer — re-ask with a larger timeoutMs if you need the rest.\n\n'
      : ''
    const footer = ['chat ' + (value.chatId || 'unknown'), 'model ' + value.model, (value.elapsedMs / 1000).toFixed(1) + 's']
    if (value.recovered) {
      footer.push('tab froze mid-answer, reloaded and re-read the saved response')
    }
    if (value.partial) {
      footer.push('INCOMPLETE: timed out mid-answer')
    }
    if (value.truncated) {
      footer.push('showing ' + value.text.length + ' of ' + value.chars + ' characters, full answer at ' + value.savedTo)
    } else if (value.savedTo) {
      footer.push('saved to ' + value.savedTo)
    }
    if (value.files) footer.push(value.files.length + ' file(s) attached')
    if (value.sessionKind === 'nonChat') {
      footer.push('WARNING: this tab is not a conversation page (' + (value.sessionUrl || '?') + ')')
    } else if (value.sessionKind === 'new') {
      footer.push('session: new chat')
    } else if (value.sessionKind === 'existing') {
      footer.push('session: conversation ' + (value.sessionConversationId || '?'))
    }
    return [{ type: 'text', text: banner + body + '\n\n— ' + footer.join(' · ') }]
  }

  /**
   * The canonical schema of an ask result, shared by both ask tools.
   *
   * @param {boolean} withFiles - Whether the value also carries the attached file list.
   * @returns {Record<string, unknown>} The output schema.
   */
  function answerSchema(withFiles) {
    return {
      type: 'object',
      additionalProperties: false,
      properties: compact({
        chatId: { type: 'string', required: true, description: 'URL of the Gemini conversation that answered.' },
        text: { type: 'string', required: true, description: 'The answer, bounded to the configured inline budget.' },
        chars: { type: 'integer', required: true, description: 'Length of the complete answer before bounding.' },
        truncated: { type: 'boolean', required: true, description: 'Whether text holds only the head of the answer.' },
        partial: {
          type: 'boolean',
          required: true,
          description: 'Whether the wait timed out mid-answer, making every character above an unfinished fragment.',
        },
        recovered: {
          type: 'boolean',
          required: true,
          description: 'Whether the answer was re-read from the saved conversation after a tab freeze.',
        },
        model: { type: 'string', required: true, description: 'Model id this ask used.' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock duration of the browser round trip.' },
        savedTo: { type: 'string', description: 'Absolute path the complete answer was written to.' },
        files: withFiles
          ? { type: 'array', required: true, items: { type: 'string' }, description: 'Files that were attached.' }
          : undefined,
        sessionKind: {
          type: 'string',
          required: true,
          enum: ['none', 'nonChat', 'new', 'existing'],
          description: 'Which session the ask was sent into: none = no Gemini tab (the ask opens one); '
            + 'nonChat = a sign-in or consent page; new = a fresh empty chat; existing = a conversation with an id.',
        },
        sessionUrl: { type: 'string', description: 'URL of the tab the ask was sent into.' },
        sessionConversationId: { type: 'string', description: 'The conversation id from that URL, or empty for a fresh chat.' },
      }),
    }
  }

  tools.push({
    name: 'gemini_ask',
    description:
      'Send a prompt to Gemini in the operator\'s real Chrome tab and wait for the complete answer. This drives a '
      + 'human-visible browser session, so it is slower and more observable than a web search: use it for prompts '
      + 'that need the user\'s logged-in Gemini session, long-form answers, or analysis of a document the user '
      + 'has open. Returns the answer text.',
    parameters: {
      query: { type: 'string', required: true, description: 'The prompt to type into Gemini.' },
      model: { type: 'string', description: 'Model id to request (default: the configured model, currently flash).' },
      newChat: { type: 'boolean', description: 'Start a fresh conversation instead of continuing the open one.' },
      timeoutMs: { type: 'number', description: 'How long to wait for the turn to complete (default: the configured timeout).' },
      saveTo: { type: 'string', description: 'Write the complete answer to this path as well as returning it.' },
    },
    output: { schema: answerSchema(false), render: (_args, value) => renderAnswer(value) },
    async execute(args, exec) {
      return runAsk(args, exec, 'gemini_ask')
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Ask Gemini',
      kind: 'other',
      rawInput: summarize(args.query, 120),
    }),
  })

  tools.push({
    name: 'gemini_ask_with_files',
    description:
      'Attach local files to the Gemini tab, then send a prompt in one atomic call. Use it to ask questions about '
      + 'a document, image, PDF, or CSV that Gemini must read. The files are uploaded one at a time and verified '
      + 'before the prompt is sent, so a silent partial upload fails the call instead of producing a bad answer.',
    parameters: {
      query: { type: 'string', required: true, description: 'The prompt to send once the files are attached.' },
      files: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Absolute or project-relative paths of the files to attach.',
      },
      model: { type: 'string', description: 'Model id to request (default: the configured model, currently flash).' },
      newChat: { type: 'boolean', description: 'Start a fresh conversation instead of continuing the open one.' },
      timeoutMs: { type: 'number', description: 'How long to wait for the turn to complete (default: the configured timeout).' },
      saveTo: { type: 'string', description: 'Write the complete answer to this path as well as returning it.' },
    },
    output: { schema: answerSchema(true), render: (_args, value) => renderAnswer(value) },
    async execute(args, exec) {
      return runAsk(args, exec, 'gemini_ask_with_files', requireList(args.files, 'files'))
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Ask Gemini with files',
      kind: 'other',
      rawInput: summarize(args.query, 100) + ' (' + (Array.isArray(args.files) ? args.files.length : 0) + ' file(s))',
    }),
  })

  // -------------------------------------------------------------- collect --

  tools.push({
    name: 'gemini_collect',
    description:
      'Recover the answer to a gemini_ask that timed out, instead of re-asking and paying for the same reasoning '
      + 'twice. When a turn is cut off the request is already in flight and Gemini usually finishes it anyway; this '
      + 'hands back that finished answer, either from the extension\'s late reply or by re-reading the conversation '
      + 'Gemini already saved. Use it as the first move after a timeout, before retrying the prompt. The answer is '
      + 'flagged as recovered.',
    parameters: {
      actionId: {
        type: 'string',
        description: 'Id of the timed-out action, when the caller captured one. Defaults to the most recent timed-out ask.',
      },
      timeoutMs: { type: 'number', description: 'How long to wait when re-reading the saved conversation (default 45s).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chatId: { type: 'string', required: true, description: 'URL of the Gemini conversation that answered.' },
          text: { type: 'string', required: true, description: 'The recovered answer.' },
          chars: { type: 'integer', required: true, description: 'Length of the recovered answer.' },
          source: {
            type: 'string',
            required: true,
            description: 'How it was recovered: late-reply (the extension answered after the timeout) or saved-conversation (re-read from the page).',
          },
          recovered: { type: 'boolean', required: true, description: 'Always true: the answer came from a turn whose wait had already expired.' },
          elapsedMs: { type: 'integer', required: true, description: 'Wall-clock duration of the collection.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: '[RECOVERED ANSWER — the original call timed out; this is the turn it abandoned]\n\n'
          + (value.text.trim().length > 0 ? value.text : '(the conversation held no completed answer to collect.)')
          + '\n\n(' + value.chars + ' chars, recovered from ' + value.source + ' in '
          + (value.elapsedMs / 1000).toFixed(1) + 's)',
      }],
    },
    async execute(args, exec) {
      const startedAt = Date.now()
      const response = await bridge.call(
        'gemini_collect',
        adapter => adapter.collectLastResponse({
          actionId: typeof args.actionId === 'string' && args.actionId.length > 0 ? args.actionId : undefined,
          timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        }),
        exec.signal,
      )
      const text = typeof response?.text === 'string' ? response.text : ''
      return {
        chatId: typeof response?.chatId === 'string' ? response.chatId : '',
        text,
        chars: text.length,
        // A re-read is the fallback, so anything that is not a retained reply
        // came from the saved conversation.
        source: response?.recoveredFrom === 'late-reply' ? 'late-reply' : 'saved-conversation',
        recovered: true,
        elapsedMs: Date.now() - startedAt,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Collect timed-out Gemini answer', kind: 'other' }),
  })

  // ------------------------------------------------------------ screenshot --

  tools.push({
    name: 'gemini_screenshot',
    description:
      'Capture a PNG of the Gemini viewport. The window is maximized and the Gemini tab focused first, so the '
      + 'image shows what the user sees. Use it to show the user the current state, or to read something visible '
      + 'that the DOM tools cannot describe. Writes a PNG and returns its path.',
    parameters: {
      label: { type: 'string', description: 'Short label for the file name (default: gemini).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Absolute path of the written PNG.' },
          bytes: { type: 'integer', required: true, description: 'Size of the PNG in bytes.' },
          capturedAt: { type: 'string', required: true, description: 'ISO instant of the capture.' },
          label: { type: 'string', required: true, description: 'Label used in the file name.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Captured the Gemini viewport (' + formatBytes(value.bytes) + ').\n\n!['
          + value.label + '](<' + value.path + '>)',
      }],
      // The path is the one replayable fact a UI card needs: the model-facing
      // text already embeds the image, so the card does not re-read the file.
      presentationMeta: (_args, value) => ({ path: value.path, bytes: value.bytes }),
    },
    async execute(args, exec) {
      const label = typeof args.label === 'string' && args.label.trim().length > 0 ? args.label.trim() : 'gemini'
      const dataUrl = await bridge.call('gemini_screenshot', adapter => adapter.captureScreenshot(), exec.signal)
      const base64 = String(dataUrl ?? '').replace(/^data:image\/png;base64,/, '')
      if (base64.length === 0) throw new Error('The extension returned an empty screenshot payload')
      const written = await writeArtifact(artifactPath(config.screenshotDir, label, { ext: 'png' }), Buffer.from(base64, 'base64'))
      return {
        path: written.path,
        bytes: written.bytes,
        capturedAt: new Date().toISOString(),
        label: slugify(label, 'gemini'),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Capture Gemini screenshot',
      kind: 'fetch',
      rawInput: args.label,
    }),
    presentResult: (_args, result) => {
      const path = typeof result.meta?.path === 'string' ? result.meta.path : ''
      return {
        card: 'generic',
        title: 'Gemini screenshot',
        content: [{ type: 'text', text: path ? 'Saved to ' + path : '' }],
      }
    },
  })

  // ----------------------------------------------------------- dom snapshot --

  tools.push({
    name: 'gemini_dom_snapshot',
    description:
      'Read a serialized outline of the Gemini page: every element with its tag, classes, attributes, visibility '
      + 'and geometry, computed in the page. Use it to discover the real selectors for a control before clicking '
      + 'or typing, and to see what the page currently shows when a screenshot is not enough. Returns JSON.',
    parameters: {
      selector: { type: 'string', description: 'CSS selector to outline from (default: the whole body).' },
      maxDepth: { type: 'integer', description: 'Levels of children to keep below the match (default 6, 0 keeps only the match).' },
      saveTo: { type: 'string', description: 'Write the complete outline to this path as well as returning it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: { type: 'string', required: true, description: 'Selector the outline was taken from.' },
          url: { type: 'string', required: true, description: 'Page URL at capture time.' },
          title: { type: 'string', required: true, description: 'Page title at capture time.' },
          maxDepth: { type: 'integer', required: true, description: 'Depth bound applied to the returned outline.' },
          nodeCount: { type: 'integer', required: true, description: 'Nodes in the returned outline.' },
          totalNodeCount: { type: 'integer', required: true, description: 'Nodes in the full outline before the depth bound.' },
          visibleNodeCount: { type: 'integer', required: true, description: 'Nodes in the returned outline marked visible.' },
          json: { type: 'string', required: true, description: 'The outline as pretty-printed JSON, bounded in length.' },
          truncated: { type: 'boolean', required: true, description: 'Whether json holds only the head of the outline.' },
          savedTo: { type: 'string', description: 'Absolute path the complete outline was written to.' },
        },
      },
      render: (_args, value) => {
        const head = 'Outline of ' + value.selector + ' on ' + value.url + ' — ' + value.nodeCount + ' of '
          + value.totalNodeCount + ' nodes at maxDepth ' + value.maxDepth + ' (' + value.visibleNodeCount + ' visible).'
        const tail = value.truncated
          ? 'Showing the first ' + value.json.length + ' characters; the complete outline is at ' + value.savedTo + '.'
          : ''
        return [{ type: 'text', text: head + (tail ? '\n' + tail : '') + '\n\n' + value.json }]
      },
    },
    async execute(args, exec) {
      const selector = typeof args.selector === 'string' && args.selector.trim().length > 0
        ? args.selector.trim()
        : null
      const maxDepth = typeof args.maxDepth === 'number' && args.maxDepth >= 0 ? Math.floor(args.maxDepth) : 6

      const dump = await bridge.call('gemini_dom_snapshot', adapter => adapter.dumpDom(selector ?? undefined), exec.signal)
      if (!dump || typeof dump !== 'object') {
        throw new Error('The extension returned no DOM payload. Confirm the content script is loaded by reloading the Gemini tab.')
      }
      if (dump.ok === false) {
        throw new Error('The page could not be outlined: ' + (dump.error ?? 'unknown reason'))
      }

      const pruned = pruneTree(dump.tree, maxDepth)
      const totalNodeCount = countNodes(dump.tree)
      const fullJson = JSON.stringify(pruned, null, 2)
      const json = boundText(fullJson, config.maxJsonChars)
      const requested = resolveOutputPath(config.projectRoot, args.saveTo)
      const target = requested
        ?? (json.truncated ? artifactPath(config.transcriptDir, 'dom-' + slugify(selector, 'body'), { ext: 'json' }) : null)
      const savedTo = target ? (await writeArtifact(target, fullJson)).path : undefined

      return compact({
        selector: selector ?? 'body',
        url: typeof dump.url === 'string' ? dump.url : '',
        title: typeof dump.title === 'string' ? dump.title : '',
        maxDepth,
        nodeCount: countNodes(pruned),
        totalNodeCount,
        visibleNodeCount: countVisibleNodes(pruned),
        json: json.text,
        truncated: json.truncated,
        savedTo,
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Snapshot Gemini DOM',
      kind: 'read',
      rawInput: (typeof args.selector === 'string' && args.selector) || 'body',
    }),
  })

  // -------------------------------------------------------------- page info --

  tools.push({
    name: 'gemini_page_info',
    description:
      'Read the current Gemini page: URL, title, how many file inputs the composer has, how many drop zones are '
      + 'present, and how many buttons exist. It is the cheapest way to tell whether the page is in a usable state '
      + 'before a longer operation, and which of the click and upload tools can work.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true, description: 'Current page URL.' },
          title: { type: 'string', required: true, description: 'Current page title.' },
          fileInputs: { type: 'integer', required: true, description: 'Number of file inputs in the document.' },
          dropzones: { type: 'integer', required: true, description: 'Number of file drop zones in the document.' },
          buttons: { type: 'integer', required: true, description: 'Number of buttons in the document.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          'url: ' + value.url,
          'title: ' + value.title,
          'file inputs: ' + value.fileInputs,
          'drop zones: ' + value.dropzones,
          'buttons: ' + value.buttons,
        ].join('\n'),
      }],
    },
    async execute(_args, exec) {
      const info = await bridge.call('gemini_page_info', adapter => adapter.getPageInfo(), exec.signal)
      if (!info || info.success === false) {
        throw new Error('The page did not report its state: ' + (info?.error ?? 'no response from the content script'))
      }
      return {
        url: typeof info.url === 'string' ? info.url : '',
        title: typeof info.title === 'string' ? info.title : '',
        fileInputs: Number(info.fileInputs) || 0,
        dropzones: Number(info.dropzones) || 0,
        buttons: Number(info.buttons) || 0,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Read Gemini page info', kind: 'read' }),
  })

  // ------------------------------------------------------------------ tabs --

  tools.push({
    name: 'gemini_tabs',
    description:
      'List the open Gemini tabs in the browser: id, title, URL, whether the tab is active, and its tab group. Use '
      + 'it to find the tab to work in, or to confirm that a conversation the user mentioned is already open.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true, description: 'Chrome tab id.' },
                title: { type: 'string', required: true, description: 'Tab title, empty when Chrome has not resolved it.' },
                url: { type: 'string', required: true, description: 'Tab URL.' },
                active: { type: 'boolean', required: true, description: 'Whether this is the active tab in its window.' },
                groupName: { type: 'string', required: true, description: 'Tab group title, empty when ungrouped.' },
              },
            },
            description: 'Every open Gemini tab.',
          },
          count: { type: 'integer', required: true, description: 'Number of tabs returned.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'No Gemini tabs are open.'
          : value.tabs
            .map(tab => '#' + tab.id + ' ' + (tab.active ? '[active] ' : '') + (tab.title || '(untitled)')
              + ' — ' + tab.url + (tab.groupName ? ' (group: ' + tab.groupName + ')' : ''))
            .join('\n'),
      }],
    },
    async execute(_args, exec) {
      const tabs = await bridge.call('gemini_tabs', adapter => adapter.listTabs(), exec.signal)
      const list = Array.isArray(tabs) ? tabs : []
      return {
        tabs: list.map(tab => ({
          id: Number(tab?.id) || 0,
          title: typeof tab?.title === 'string' ? tab.title : '',
          url: typeof tab?.url === 'string' ? tab.url : '',
          active: tab?.active === true,
          groupName: typeof tab?.groupName === 'string' ? tab.groupName : '',
        })),
        count: list.length,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'List Gemini tabs', kind: 'search' }),
  })

  // --------------------------------------------------------------- history --

  tools.push({
    name: 'gemini_history',
    description:
      'List recent Gemini conversations from the sidebar, newest first as the sidebar shows them. Use it to find '
      + 'the title or URL of an earlier conversation, then pass that to gemini_open_chat to return to it.',
    parameters: {
      limit: { type: 'integer', description: 'How many conversations to return (default 20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conversations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true, description: 'Conversation title from the sidebar.' },
                url: { type: 'string', required: true, description: 'Conversation URL.' },
              },
            },
            description: 'Conversations, bounded by limit.',
          },
          count: { type: 'integer', required: true, description: 'Number of conversations returned.' },
          total: { type: 'integer', required: true, description: 'Number of conversations found in the sidebar.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.total === 0
          ? 'The Gemini sidebar has no conversations.'
          : value.conversations
            .map((chat, index) => (index + 1) + '. ' + (chat.title || '(untitled)') + ' — ' + chat.url)
            .join('\n'),
      }],
    },
    async execute(args, exec) {
      const history = await bridge.call('gemini_history', adapter => adapter.listHistory(), exec.signal)
      const list = Array.isArray(history) ? history : []
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 20
      const conversations = list
        .slice(0, limit)
        .map(chat => ({
          title: typeof chat?.title === 'string' ? chat.title : '',
          url: typeof chat?.url === 'string' ? chat.url : '',
        }))
      return { conversations, count: conversations.length, total: list.length }
    },
    presentCall: () => ({ card: 'generic', title: 'List Gemini chats', kind: 'search' }),
  })

  // ------------------------------------------------------------- open chat --

  tools.push({
    name: 'gemini_open_chat',
    description:
      'Switch the browser back to an existing Gemini conversation, matched by title or URL fragment. Use it after '
      + 'gemini_history to continue an earlier thread, or when the user refers to a conversation by name.',
    parameters: {
      match: { type: 'string', required: true, description: 'Title text or URL fragment identifying the conversation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          match: { type: 'string', required: true, description: 'The match that was requested.' },
          url: { type: 'string', required: true, description: 'URL of the conversation now open.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Switched to the conversation matching "' + value.match + '": ' + value.url,
      }],
    },
    async execute(args, exec) {
      const match = requireText(args.match, 'match')
      const result = await bridge.call(
        'gemini_open_chat',
        adapter => adapter.selectHistory({ title: match, url: match }),
        exec.signal,
      )
      return { match, url: typeof result?.url === 'string' ? result.url : '' }
    },
    presentCall: args => ({ card: 'generic', title: 'Open Gemini chat', kind: 'other', rawInput: args.match }),
  })

  // ----------------------------------------------------------------- click --

  tools.push({
    name: 'gemini_click',
    description:
      'Click one element in the Gemini page by CSS selector. Prefer gemini_dom_snapshot first to learn the real '
      + 'selector: Gemini rebuilds its DOM often, so a selector taken from a fresh outline is the one that works. '
      + 'Use this for controls the tools do not cover, such as a menu or a consent dialog.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the element to click.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: { type: 'string', required: true, description: 'The selector that was clicked.' },
          detail: { type: 'string', required: true, description: 'What the page reported after the click.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: 'Clicked ' + value.selector + ': ' + value.detail,
      }],
    },
    async execute(args, exec) {
      const selector = requireText(args.selector, 'selector')
      const result = await bridge.call('gemini_click', adapter => adapter.clickButton(selector), exec.signal)
      if (result?.success === false) {
        throw new Error('The page refused the click: ' + (result?.error ?? 'unknown reason'))
      }
      return { selector, detail: typeof result?.result === 'string' ? result.result : 'clicked' }
    },
    presentCall: args => ({ card: 'generic', title: 'Click in Gemini page', kind: 'other', rawInput: args.selector }),
  })

  // ------------------------------------------------- cookies (opt-in only) --

  if (config.enableCookieTools === true) {
    tools.push({
      name: 'gemini_cookies_backup',
      description:
        'Back up the live session cookies for a domain to a JSON file. The values are written to disk and are '
        + 'NOT returned: treat the file as a credential. Registered only when the plugin is configured with '
        + 'enableCookieTools.',
      parameters: {
        domain: { type: 'string', description: 'Domain to back up (default: gemini.google.com).' },
        saveTo: { type: 'string', description: 'Path to write the backup to instead of the transcript directory.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            domain: { type: 'string', required: true, description: 'Domain that was backed up.' },
            count: { type: 'integer', required: true, description: 'Number of cookies written.' },
            savedTo: { type: 'string', required: true, description: 'Absolute path of the backup file.' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: 'Backed up ' + value.count + ' cookies for ' + value.domain + ' to ' + value.savedTo
            + '. Cookie values were not returned; treat that file as a credential.',
        }],
        presentationMeta: (_args, value) => ({ path: value.savedTo, count: value.count }),
      },
      async execute(args, exec) {
        const domain = typeof args.domain === 'string' && args.domain.trim().length > 0
          ? args.domain.trim()
          : DEFAULT_COOKIE_DOMAIN
        const cookies = await bridge.call('gemini_cookies_backup', adapter => adapter.getCookies(domain), exec.signal)
        const list = Array.isArray(cookies) ? cookies : []
        const target = resolveOutputPath(config.projectRoot, args.saveTo)
          ?? artifactPath(config.transcriptDir, 'cookies-' + slugify(domain, 'cookies'), { ext: 'json' })
        const written = await writeArtifact(target, JSON.stringify(list, null, 2))
        return { domain, count: list.length, savedTo: written.path }
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Back up cookies',
        kind: 'other',
        rawInput: args.domain,
      }),
    })

    tools.push({
      name: 'gemini_cookies_restore',
      description:
        'Clear a domain\'s cookies and restore a previous backup, which signs the browser back into that site. This '
        + 'DESTROYS the current session for the domain, so confirm with the user first. Registered only when the '
        + 'plugin is configured with enableCookieTools.',
      parameters: {
        file: { type: 'string', required: true, description: 'Path of the JSON backup to restore.' },
        domain: { type: 'string', description: 'Domain to restore (default: gemini.google.com).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            domain: { type: 'string', required: true, description: 'Domain that was restored.' },
            count: { type: 'integer', required: true, description: 'Number of cookies restored.' },
            savedTo: { type: 'string', required: true, description: 'The backup file that was read.' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: 'Restored ' + value.count + ' cookies for ' + value.domain + ' from ' + value.savedTo
            + '. The previous session for that domain was cleared first.',
        }],
      },
      async execute(args, exec) {
        const file = resolveOutputPath(config.projectRoot, requireText(args.file, 'file'))
        if (!file) throw new Error('file must be an absolute or project-relative path')
        const domain = typeof args.domain === 'string' && args.domain.trim().length > 0
          ? args.domain.trim()
          : DEFAULT_COOKIE_DOMAIN
        const cookies = await readJsonFile(file)
        if (!Array.isArray(cookies)) {
          throw new Error(file + ' does not contain a cookie array')
        }
        await bridge.call('gemini_cookies_restore', adapter => adapter.restoreCookies(domain, cookies), exec.signal)
        return { domain, count: cookies.length, savedTo: file }
      },
      presentCall: args => ({ card: 'generic', title: 'Restore cookies', kind: 'other', rawInput: args.file }),
    })
  }

  return tools
}

/**
 * The `/gemini` command: the same status the tool reports, without spending a
 * model turn, plus the one-line map of what else the bridge can do.
 *
 * @param {ReturnType<typeof createBridge>} bridge - The shared bridge.
 * @param {Record<string, any>} config - Normalized plugin configuration.
 * @returns {object} A command definition.
 */
function createCommand(bridge, config) {
  return {
    name: 'gemini',
    description: 'Report the timepass Gemini bridge status (add "probe" to re-check the extension)',
    async handler(invocation) {
      const wants = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim().toLowerCase() : ''
      const probed = wants.includes('probe')
      const snapshot = probed ? await bridge.probe() : bridge.status()
      const lines = statusLines(statusValue(snapshot, probed))
      lines.push('')
      lines.push('tools: gemini_ask, gemini_ask_with_files, gemini_collect, gemini_screenshot, gemini_dom_snapshot, '
        + 'gemini_page_info, gemini_tabs, gemini_session, gemini_history, gemini_open_chat, gemini_click'
        + (config.enableCookieTools ? ', gemini_cookies_backup, gemini_cookies_restore' : ''))
      return { kind: 'success', text: lines.join('\n') }
    },
  }
}

/**
 * The loaded adapter class, without waiting for a bridge to be started.
 *
 * Returns null when the adapter cannot be loaded at all — which the bridge
 * reports in far better words on the first real call, and which must not stop
 * the plugin from mounting here.
 *
 * Memoized, so the audit at mount and any later caller share one import.
 *
 * @returns {Promise<object | null>} The adapter class, or null.
 */
let adapterPrototypePromise = null
function adapterPrototype() {
  if (!adapterPrototypePromise) {
    adapterPrototypePromise = loadGeminiAdapter()
      .then(module => module.GeminiAdapter)
      .catch(() => null)
  }
  return adapterPrototypePromise
}

/**
 * Mount the plugin: one bridge, the `gemini_*` tools, and the `/gemini`
 * command.
 *
 * @param {any} ctx - The Cordis context carrying the tool and command registries.
 * @param {Record<string, any>} rawConfig - The profile's configuration for this row.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig ?? {})
  const bridge = createBridge(config)

  const tools = createTools(bridge, config)
  for (const tool of tools) {
    ctx.tools.register(defineTool(tool))
  }
  ctx.commands.register(createCommand(bridge, config))

  // Compare what was just registered against the adapter this process will
  // actually load. A tool registered against an adapter that predates it is the
  // failure the last retest ran into silently: the tool exists in the source,
  // calls a method that is not there, and the model sees an error with no
  // explanation. Checked at mount so it is on the console before the first call,
  // and again in gemini_status where the model can read it.
  adapterPrototype().then(proto => {
    const audit = auditToolRegistry(tools.map(tool => tool.name), proto)
    bridge.setRegistryAudit(audit)
    if (!audit.ok) {
      for (const line of describeRegistryAudit(audit)) {
        console.warn('[timepass-gemini] tool registry: ' + line)
      }
    }
  })

  // The WebSocket port outlives a single tool call, so it is owned by the fiber:
  // disposing the plugin (a hot reload, or the host shutting down) releases it.
  ctx.effect(() => () => {
    void bridge.dispose()
  }, 'timepass-gemini: bridge')
}
