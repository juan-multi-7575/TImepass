import { loadGeminiAdapter } from './adapter-loader.js'
import { BRIDGE_PORT } from './config.js'

/**
 * Connection manager for the timepass bridge.
 *
 * The timepass `ExtensionDriver` is a WebSocket *server*: it binds a port and
 * resolves only once the Chrome extension dials in. That makes the lifecycle
 * the opposite of a client's, and this module is where that is handled once for
 * every tool:
 *
 *   - the server is started lazily, on the first call that needs the browser,
 *     so a host that never uses these tools never holds the port;
 *   - concurrent calls share one in-flight connect instead of racing two
 *     servers onto the same port;
 *   - a failed connect closes the half-open server again, because a driver that
 *     timed out still holds the port and the next attempt would see EADDRINUSE;
 *   - every failure is rewritten into an operator-actionable sentence, because
 *     the model that reads it cannot see the browser.
 * @module dsh-timepass-gemini/bridge
 */

/** What to do when the extension is not on the bridge. */
const EXTENSION_HINT = [
  'The timepass Chrome extension is not connected to ws://127.0.0.1:' + BRIDGE_PORT + '.',
  'Open chrome://extensions, turn on Developer mode, click "Load unpacked" and pick the',
  "timepass/extension directory, then keep a gemini.google.com tab open and retry.",
].join(' ')

/** Driver error text that means "the socket is up, the extension is not". */
const NOT_CONNECTED = /extension not connected/i

/** How often a reconnect wait re-probes the bridge, in milliseconds. */
const PROBE_INTERVAL_MS = 750

/**
 * Reject when `promise` outlives `ms`, without leaving a timer behind.
 *
 * The losing promise keeps running (the driver owns its own request map) but is
 * given a no-op handler, so a late rejection is never an unhandled rejection.
 *
 * @template T
 * @param {Promise<T>} promise - The work to bound.
 * @param {number} ms - The budget; a non-positive or non-finite value disables the bound.
 * @param {string} label - What timed out, for the error message.
 * @returns {Promise<T>} The same promise, or a rejection once the budget is spent.
 */
function withTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  promise.catch(() => {})
  let timer
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms)
  })
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer))
}

/**
 * Settle when `promise` settles or `signal` aborts, whichever comes first.
 *
 * Cancellation stops the *wait*: the browser keeps generating its answer, since
 * the WebSocket request cannot be recalled once it was sent.
 *
 * @template T
 * @param {Promise<T>} promise - The work to observe.
 * @param {AbortSignal | undefined} signal - The caller's cancellation signal.
 * @param {string} label - What was cancelled, for the error message.
 * @returns {Promise<T>} The work's value, or a rejection naming the cancellation.
 */
function withSignal(promise, signal, label) {
  if (!signal) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(new Error(label + ' was cancelled'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(label + ' was cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Rewrite a driver failure into something the reader can act on.
 *
 * @param {unknown} error - The original failure.
 * @returns {string} An actionable message.
 */
function explain(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/already in use/i.test(message)) {
    return 'Port ' + BRIDGE_PORT + ' is already in use, so another timepass client (the CLI, the MCP '
      + 'server, or another harness) already owns the bridge. Stop it, or leave the extension connected '
      + 'to that client, and retry.'
  }
  // Both waits for the extension race: the driver has its own 10s ceiling and
  // the plugin has a configurable one, so either may report first. They must
  // produce the same instruction.
  if (/not connected within timeout|Connecting to the timepass extension timed out/i.test(message)) {
    return EXTENSION_HINT
  }
  return message
}

/**
 * Create the bridge used by every `gemini_*` tool in one plugin fiber.
 *
 * @param {Record<string, any>} config - Normalized plugin configuration.
 * @returns {{ call: Function, probe: Function, status: Function, dispose: Function }} The bridge.
 */
export function createBridge(config) {
  const { model, connectTimeoutMs, extensionWaitMs, verbose } = config

  /** @type {any} The live adapter, or null while the bridge is down. */
  let adapter = null
  /** @type {Promise<any> | null} The in-flight connect, shared by concurrent callers. */
  let connecting = null
  /** @type {'idle' | 'connecting' | 'ready' | 'error' | 'disposed'} */
  let state = 'idle'
  /** @type {boolean | null} Whether the extension is on the bridge; null until known. */
  let extensionConnected = null
  /** @type {string | null} */
  let lastError = null
  /** @type {string | null} ISO instant the current adapter connected. */
  let connectedAt = null
  /** @type {string | null} Which module the adapter class came from. */
  let adapterFrom = null
  let disposed = false

  /**
   * @param {string} message - The transition to report.
   * @returns {void}
   */
  function log(message) {
    if (verbose) console.log('[timepass-gemini] ' + message)
  }

  /**
   * Start the bridge: load the adapter class, connect, and adopt the instance.
   *
   * @returns {Promise<any>} The connected adapter.
   */
  async function start() {
    state = 'connecting'
    const { GeminiAdapter, from } = await loadGeminiAdapter()
    adapterFrom = from
    const instance = new GeminiAdapter({ model, driver: 'extension' })
    try {
      await withTimeout(instance.connect(), connectTimeoutMs, 'Connecting to the timepass extension')
    } catch (error) {
      // A driver that timed out still holds the port; release it so the next
      // call can try again instead of failing forever with EADDRINUSE.
      await instance.close().catch(() => {})
      throw error
    }
    adapter = instance
    state = 'ready'
    extensionConnected = true
    lastError = null
    connectedAt = new Date().toISOString()
    log('bridge ready on port ' + BRIDGE_PORT + ' (adapter from ' + from + ')')
    return instance
  }

  /**
   * Return a connected adapter, starting the bridge or joining an existing
   * connect attempt as needed.
   *
   * @returns {Promise<any>} The connected adapter.
   */
  function ensureAdapter() {
    if (disposed) {
      return Promise.reject(new Error('The timepass Gemini bridge was disposed; reload the plugin to use it again.'))
    }
    if (state === 'ready' && adapter) return Promise.resolve(adapter)
    if (!connecting) {
      connecting = start().catch(error => {
        state = 'error'
        lastError = explain(error)
        throw new Error(lastError)
      }).finally(() => {
        connecting = null
      })
    }
    return connecting
  }

  /**
   * Wait for the extension to dial back in after a disconnect.
   *
   * `tab_list` is the cheapest round trip the driver offers: the service worker
   * answers it without touching a page, so it distinguishes "extension absent"
   * from "page action failed".
   *
   * @param {any} instance - The connected adapter.
   * @param {AbortSignal | undefined} signal - The caller's cancellation signal.
   * @returns {Promise<void>} Resolves once the extension answers, or throws.
   */
  async function waitForExtension(instance, signal) {
    const deadline = Date.now() + Math.max(0, extensionWaitMs)
    for (;;) {
      if (signal?.aborted) throw new Error('Waiting for the timepass extension was cancelled')
      try {
        await withSignal(instance.listTabs(), signal, 'Waiting for the timepass extension')
        extensionConnected = true
        lastError = null
        log('extension reconnected')
        return
      } catch (error) {
        if (signal?.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (!NOT_CONNECTED.test(message)) throw error
        if (Date.now() >= deadline) {
          extensionConnected = false
          throw new Error(EXTENSION_HINT)
        }
        await new Promise(resolve => setTimeout(resolve, PROBE_INTERVAL_MS))
      }
    }
  }

  /**
   * Run one adapter action with the bridge up and the extension reachable.
   *
   * @param {string} label - The tool name, used in cancellation and error text.
   * @param {(adapter: any) => Promise<any>} action - The adapter call to run.
   * @param {AbortSignal} [signal] - The caller's cancellation signal.
   * @returns {Promise<any>} The action's value.
   */
  async function call(label, action, signal) {
    const instance = await ensureAdapter()
    if (extensionConnected === false) await waitForExtension(instance, signal)
    try {
      return await withSignal(action(instance), signal, label)
    } catch (error) {
      if (error instanceof Error && NOT_CONNECTED.test(error.message)) {
        extensionConnected = false
        log('extension disconnected')
        throw new Error(label + ' failed: ' + EXTENSION_HINT)
      }
      throw error
    }
  }

  /**
   * Establish the bridge if it is not up, then ask the extension a cheap
   * question to refresh the health snapshot.
   *
   * Never throws: a probe is diagnostics, and a failed probe is the answer. A
   * connect that fails leaves the extension state unknown rather than
   * disconnected, because nothing was ever listening for it to drop from.
   *
   * @param {AbortSignal} [signal] - The caller's cancellation signal.
   * @returns {Promise<Record<string, any>>} The status snapshot after the probe.
   */
  async function probe(signal) {
    let instance
    try {
      instance = await ensureAdapter()
    } catch {
      return status()
    }
    try {
      await withSignal(instance.listTabs(), signal, 'gemini_status')
      extensionConnected = true
      lastError = null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (NOT_CONNECTED.test(message)) {
        extensionConnected = false
        lastError = EXTENSION_HINT
      } else {
        lastError = message
      }
    }
    return status()
  }

  /**
   * A snapshot of the bridge, safe to render when nothing is connected.
   *
   * @returns {Record<string, any>} The health snapshot.
   */
  function status() {
    return {
      state,
      bridgePort: BRIDGE_PORT,
      // The driver owns the port; read it back so status stays honest if the
      // project ever makes it configurable.
      port: adapter?.driver?.port ?? BRIDGE_PORT,
      extensionConnected,
      connectedAt,
      adapterFrom,
      lastError,
      model,
      connectTimeoutMs,
      extensionWaitMs,
      projectRoot: config.projectRoot,
      screenshotDir: config.screenshotDir,
      transcriptDir: config.transcriptDir,
      cookieToolsEnabled: config.enableCookieTools === true,
    }
  }

  /**
   * Close the bridge and release the port.
   *
   * Cordis calls this when the plugin fiber is disposed, which is what keeps a
   * hot reload from leaving the bridge port bound by a dead adapter.
   *
   * @returns {Promise<void>} Resolves once the socket is closed.
   */
  async function dispose() {
    disposed = true
    state = 'disposed'
    const instance = adapter
    adapter = null
    extensionConnected = null
    connectedAt = null
    if (instance) {
      await instance.close().catch(() => {})
      log('bridge disposed')
    }
  }

  return { call, probe, status, dispose }
}
