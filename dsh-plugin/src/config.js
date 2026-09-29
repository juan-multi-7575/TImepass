import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'

/**
 * Deployment configuration for the timepass Gemini bridge.
 *
 * Every field carries a schema default, so a profile can mount the bundle's
 * single row with no `config` block and still get a working plugin.
 * @module dsh-timepass-gemini/config
 */

/** Absolute path of the `dsh-plugin` package directory (`src/` -> package root). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Absolute path of the timepass project that owns this bundle (`dsh-plugin/` -> project root). */
export const PROJECT_ROOT = path.resolve(PACKAGE_ROOT, '..')

/** WebSocket port the bridge listens on. Fixed by the contract the extension implements. */
export const BRIDGE_PORT = 9876

/**
 * Schemastery schema for the bridge. Cordis validates the profile's
 * `config` against it while the plugin loads, so a bad value fails the load
 * with an actionable error instead of surfacing as a strange tool failure.
 */
export const Config = Schema.object({
  /**
   * Gemini model id passed to the adapter on every ask. The extension currently
   * ignores the model switch while it iterates on response detection, so this
   * is a declared default rather than a guarantee.
   */
  model: Schema.string().default('flash'),
  /**
   * How long one ask may wait for a complete Gemini turn before the driver
   * gives up, in milliseconds.
   */
  timeoutMs: Schema.number().default(120000),
  /**
   * How long the first tool call waits for the Chrome extension to dial the
   * bridge, in milliseconds. The driver keeps its own shorter 10s ceiling, so
   * this bounds the plugin's own wait around it.
   */
  connectTimeoutMs: Schema.number().default(10000),
  /**
   * After a disconnect, how long a call waits for the extension to dial back in
   * before it reports the bridge as unusable, in milliseconds. A reload of the
   * extension or a freshly opened Gemini tab recovers inside this window.
   */
  extensionWaitMs: Schema.number().default(20000),
  /**
   * Characters of a Gemini answer returned inline. A longer answer is written
   * to the transcript directory and the path is returned instead, so a runaway
   * response cannot flood the model context.
   */
  maxResponseChars: Schema.number().default(12000),
  /**
   * Characters of a serialized DOM outline returned inline; the full outline is
   * written to disk when it does not fit.
   */
  maxJsonChars: Schema.number().default(16000),
  /**
   * Directory screenshots are written to, resolved against the project root
   * when relative.
   */
  screenshotDir: Schema.string().default('.timepass/screenshots'),
  /**
   * Directory full answers, DOM outlines, and cookie backups are written to,
   * resolved against the project root when relative.
   */
  transcriptDir: Schema.string().default('.timepass/transcripts'),
  /**
   * Project root that relative artifact paths resolve against. Empty means the
   * timepass project this bundle ships inside.
   */
  projectRoot: Schema.string().default(''),
  /**
   * Register the cookie backup/restore tools. Off by default: both tools handle
   * live session credentials, and restore clears a domain's cookies first.
   */
  enableCookieTools: Schema.boolean().default(false),
  /**
   * Log bridge lifecycle transitions (connect, disconnect, retry) to the host
   * console. Off by default so a normal session stays quiet.
   */
  verbose: Schema.boolean().default(false),
})

/**
 * Validate the values the schema cannot express on its own and resolve them
 * against the project root, so the tool bodies deal in absolute paths and
 * non-negative numbers only.
 *
 * @param {Record<string, unknown>} config - The validated plugin configuration.
 * @returns {Readonly<Record<string, unknown>>} The same settings, resolved and checked.
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  const projectRoot = path.resolve(
    typeof raw.projectRoot === 'string' && raw.projectRoot.length > 0 ? raw.projectRoot : PROJECT_ROOT,
  )

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) {
      throw new Error('timepass-gemini: config.' + key + ' must be a non-negative number (got ' + String(value) + ')')
    }
  }

  return Object.freeze({
    ...raw,
    projectRoot,
    screenshotDir: path.isAbsolute(raw.screenshotDir)
      ? path.normalize(raw.screenshotDir)
      : path.resolve(projectRoot, raw.screenshotDir),
    transcriptDir: path.isAbsolute(raw.transcriptDir)
      ? path.normalize(raw.transcriptDir)
      : path.resolve(projectRoot, raw.transcriptDir),
  })
}
