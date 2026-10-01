/**
 * A stand-in for the Chrome extension.
 *
 * The bridge protocol is just "the plugin's WebSocket server receives
 * `{ id, action, payload }` and expects `{ id, success, response }` back", so a
 * plain WebSocket client can stand in for the service worker. That makes every
 * success path — connect, ask, screenshot, DOM outline, history, click —
 * testable without a browser, which is the difference between a plugin that
 * loads and a plugin that works.
 *
 * It answers with the same shapes extension/background.js and
 * extension/content.js produce, so a change that breaks the real contract
 * breaks this too.
 */
import { WebSocket } from 'ws'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Port the timepass driver listens on. */
const PORT = 9876

/** Wire revision the handshake speaks; mirrors src/driver/build-info.ts. */
const PROTOCOL_VERSION = 1

/**
 * The build this fake claims to be.
 *
 * It reports the version from the real extension manifest, so the scratch
 * harness shows a *match* against the host the way a healthy setup does. Set
 * FAKE_BUILD_ID to something else to rehearse the skew path — the situation the
 * last retest ran into without noticing, and one `gemini_status` now names.
 *
 * @returns {string} The build id to report.
 */
function fakeBuildId() {
  if (process.env.FAKE_BUILD_ID) return process.env.FAKE_BUILD_ID
  const manifest = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension', 'manifest.json'
  )
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** A valid 1x1 transparent PNG, so a capture produces a real file on disk. */
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** The outline the fake page reports, deep enough to exercise depth pruning. */
const TREE = {
  tag: 'body',
  className: 'overview',
  visible: true,
  attributes: { lang: 'en' },
  children: [
    {
      tag: 'div',
      className: 'conversation',
      visible: true,
      attributes: { role: 'main' },
      children: [
        {
          tag: 'rich-textarea',
          className: 'composer',
          visible: true,
          attributes: { contenteditable: 'true', 'aria-label': 'Enter a prompt' },
          children: [
            { tag: 'p', className: 'placeholder', visible: true, children: [{ tag: 'span', visible: false, children: [] }] },
          ],
        },
        {
          tag: 'button',
          className: 'send-button',
          visible: true,
          attributes: { 'aria-label': 'Send message' },
          children: [],
        },
      ],
    },
    {
      tag: 'aside',
      className: 'sidebar',
      visible: true,
      attributes: {},
      children: [
        { tag: 'a', className: 'history-link', visible: true, attributes: { href: '/app/abc' }, children: [] },
      ],
    },
  ],
}

/** Answers per action, mirroring the real extension's response payloads. */
const RESPONSES = {
  tab_list: () => ({
    tabs: [
      { id: 11, url: 'https://gemini.google.com/app/abc', title: 'Quantum notes', active: true, pinned: true, status: 'complete', groupId: 7, groupName: 'Timepass Gemini' },
      { id: 12, url: 'https://gemini.google.com/app', title: 'New Gemini', active: false, pinned: true, status: 'complete', groupId: 7, groupName: 'Timepass Gemini' },
    ],
  }),
  tab_create: payload => ({ tabId: 13, url: payload?.url ?? 'https://gemini.google.com/app' }),
  get_page_info: () => ({
    success: true,
    url: 'https://gemini.google.com/app/abc',
    title: 'Quantum notes - Gemini',
    fileInputs: 1,
    dropzones: 2,
    buttons: 14,
  }),
  read_history: () => ({
    success: true,
    history: [
      { title: 'Quantum notes', url: 'https://gemini.google.com/app/abc' },
      { title: 'Trip planning', url: 'https://gemini.google.com/app/def' },
    ],
  }),
  select_history: payload => ({ success: true, url: 'https://gemini.google.com/app/abc?matched=' + (payload?.title ?? '') }),
  capture_screenshot: () => ({ dataUrl: PNG_1PX }),
  dom_dump: () => ({ ok: true, url: 'https://gemini.google.com/app/abc', title: 'Quantum notes - Gemini', tree: TREE }),
  click_button: payload => ({ success: true, result: 'clicked ' + payload?.selector }),
  file_upload: payload => ({ success: true, uploaded: payload?.filePaths?.length ?? 0 }),
  inject_and_send: payload => {
    // A prompt prefixed LONG: answers well past any sane inline budget, so the
    // bounding and spill path can be exercised without a real Gemini.
    const prompt = String(payload?.prompt ?? '')
    const text = prompt.startsWith('LONG:') ? 'LONG ANSWER. ' + 'x'.repeat(20000) : 'Fake extension answer for: ' + prompt
    return { success: true, turnComplete: true, text, chatId: 'https://gemini.google.com/app/abc' }
  },
  // The page-side re-read of a turn Gemini already saved. This is what the
  // host falls back to when no reply ever reached the socket.
  recover_last_response: () => ({
    success: true,
    recovered: true,
    text: 'Saved conversation answer.',
    chatId: 'https://gemini.google.com/app/abc',
  }),
  'cookies:get': () => ({ cookies: [{ name: 'SID', value: 'secret', domain: 'gemini.google.com' }] }),
  'cookies:restore': () => ({ ok: true }),
  // Present so a healthy fake reports no missing actions. Without them the
  // host's dispatch-table audit (issue #10) correctly flags the fake as stale,
  // which would teach everyone to ignore a warning that is usually real.
  tab_close: payload => ({ closed: payload?.tabId ?? null }),
  tab_switch: payload => ({ switched: payload?.tabId ?? null }),
  tab_group_list: () => ({ groups: [{ id: 7, title: 'Timepass Gemini', collapsed: false }] }),
}

/**
 * Dial the bridge, retrying until the server is listening, and answer every
 * action it sends.
 *
 * Returns before the connection exists, on purpose: the real extension also
 * connects whenever it wakes, and the bridge only starts listening once a tool
 * call needs it, so awaiting the connection here would deadlock the caller.
 * Await `ready` to wait for it.
 *
 * @param {{ port?: number, verbose?: boolean }} [options] - Where to connect.
 * @returns {{ ready: Promise<void>, close: () => void, answered: () => number }} A handle to the running fake.
 */
export function startFakeExtension(options = {}) {
  const { port = PORT, verbose = false } = options
  let socket = null
  let closed = false
  let answered = 0

  /**
   * @returns {void}
   */
  function log(message) {
    if (verbose) console.log('[fake-extension] ' + message)
  }

  /**
   * Answer one action message.
   *
   * @param {Record<string, any>} message - The action request from the bridge.
   * @returns {void}
   */
  function handle(message) {
    // The host introduces itself on connect (issue #10). Answer with the same
    // handshake the real service worker sends, so this harness keeps covering
    // the version and dispatch-table check rather than going quietly blind to
    // it the moment the protocol gains a message.
    if (message?.type === 'bridge_hello') {
      log('answering bridge_hello as ' + fakeBuildId())
      socket.send(JSON.stringify({
        type: 'bridge_hello',
        protocolVersion: PROTOCOL_VERSION,
        buildId: fakeBuildId(),
        actions: Object.keys(RESPONSES),
        asyncActions: ['type_prompt', 'inject_and_send', 'click_send', 'stream_response', 'recover_last_response'],
      }))
      return
    }

    const build = RESPONSES[message?.action]
    if (!build) {
      socket.send(JSON.stringify({ id: message?.id, success: false, error: 'Unknown action: ' + message?.action }))
      return
    }

    // Two prompt prefixes exist so a turn that outlives the host's wait can be
    // reproduced without a slow Gemini:
    //   SLOW:<ms>:…  the answer arrives that many ms later — the late reply a
    //                timed-out turn is supposed to be collected from
    //   SILENT:…     no reply ever arrives — the socket loses the answer, so
    //                only the saved conversation can supply it
    const prompt = String(message?.payload?.prompt ?? '')
    if (prompt.startsWith('SILENT:')) {
      log('ignoring ' + message.action + ' (SILENT:)')
      return
    }
    const slow = prompt.match(/^SLOW:(\d+):/)
    const delayMs = slow ? Number(slow[1]) : 0

    answered += 1
    const response = build(message.payload)
    if (delayMs > 0) {
      log('answering ' + message.action + ' after ' + delayMs + 'ms')
      setTimeout(() => {
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({ id: message.id, success: true, response }))
        }
      }, delayMs)
      return
    }
    log('answering ' + message.action)
    socket.send(JSON.stringify({ id: message.id, success: true, response: build(message.payload) }))
  }

  /**
   * Dial the bridge, or retry until it is listening.
   *
   * @returns {Promise<void>} Resolves once the fake is connected.
   */
  async function dial() {
    while (!closed) {
      try {
        socket = new WebSocket('ws://127.0.0.1:' + port)
        // Attach the handler before awaiting open: the bridge resolves its own
        // connect promise the instant the socket arrives, and the action it
        // sends immediately after would otherwise arrive with no listener.
        socket.on('message', data => handle(JSON.parse(data.toString())))
        socket.on('close', () => {
          log('bridge closed the connection')
        })
        await new Promise((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
        })
        log('connected to the bridge on port ' + port)
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
  }

  return {
    ready: dial(),
    close() {
      closed = true
      socket?.close()
    },
    answered: () => answered,
  }
}
