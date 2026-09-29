/**
 * Pure text helpers shared by the `gemini_*` tools. No I/O, no clock reads:
 * every function here is a total function of its arguments so it can be unit
 * tested and reasoned about without a browser bridge.
 * @module dsh-timepass-gemini/lib/text
 */

/**
 * Bound a model-facing string to `maxChars`, reporting the pre-bound length so
 * the caller can tell the model how much was withheld.
 *
 * A non-finite or non-positive limit means "no bound": the value passes through
 * untouched rather than collapsing to an empty string.
 *
 * @param {unknown} value - The value to bound; non-strings are stringified.
 * @param {number} maxChars - Maximum characters the caller is willing to return.
 * @returns {{ text: string, truncated: boolean, originalChars: number }} The bounded text and the length it was taken from.
 */
export function boundText(value, maxChars) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : text.length
  if (text.length <= limit) {
    return { text, truncated: false, originalChars: text.length }
  }
  return { text: text.slice(0, limit), truncated: true, originalChars: text.length }
}

/**
 * `JSON.stringify` a value and bound the result, so a large DOM outline can be
 * shown inline without flooding the model context.
 *
 * @param {unknown} value - The JSON-serializable value.
 * @param {number} maxChars - Maximum characters of JSON to keep.
 * @returns {{ text: string, truncated: boolean, originalChars: number }} The JSON text and the length it was taken from.
 */
export function boundJson(value, maxChars) {
  return boundText(JSON.stringify(value, null, 2), maxChars)
}

/**
 * Reduce a long string to a single short line for a card title: whitespace is
 * collapsed, a hard length cap is applied, and an ellipsis marks the cut.
 *
 * @param {unknown} value - The text to summarize.
 * @param {number} [maxChars] - Maximum characters of the summary.
 * @returns {string} A one-line summary, possibly empty.
 */
export function summarize(value, maxChars = 90) {
  const flat = String(value ?? '').replace(/\s+/g, ' ').trim()
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : flat.length
  return flat.length <= limit ? flat : `${flat.slice(0, Math.max(0, limit - 1))}…`
}

/**
 * Human-readable byte size, used in render prose so the model does not have to
 * read a raw byte count to know whether a capture is plausible.
 *
 * @param {number} bytes - A byte count.
 * @returns {string} A short human-readable size such as `412 KB`.
 */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
