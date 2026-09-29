import path from 'node:path'

/**
 * Pure path helpers for the artifacts a `gemini_*` tool writes. They only build
 * strings; the caller decides when to create directories or write bytes.
 * @module dsh-timepass-gemini/lib/paths
 */

/**
 * Reduce arbitrary text to a filesystem-safe token: lowercase alphanumerics
 * separated by single hyphens, with a bounded length.
 *
 * The label is a model-supplied string, so it must never be able to introduce a
 * path separator, a parent reference, or a hidden file.
 *
 * @param {unknown} value - The raw label.
 * @param {string} [fallback] - Token used when nothing usable survives sanitizing.
 * @returns {string} A safe path segment.
 */
export function slugify(value, fallback = 'artifact') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug.length > 0 ? slug : fallback
}

/**
 * A compact, sortable, filesystem-safe timestamp such as `2026-09-17T18-56-00-123Z`.
 *
 * @param {Date} [date] - The instant to format; defaults to now.
 * @returns {string} The formatted stamp.
 */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * Build the absolute path of one artifact file: a timestamped, labeled file
 * inside the configured directory.
 *
 * @param {string} directory - Absolute directory the artifact belongs in.
 * @param {string} [label] - Model-supplied label, sanitized into the name.
 * @param {{ ext?: string, date?: Date }} [options] - File extension (no dot) and the instant to stamp.
 * @returns {string} The absolute artifact path.
 */
export function artifactPath(directory, label, options = {}) {
  const { ext = 'txt', date = new Date() } = options
  return path.join(directory, `${stamp(date)}-${slugify(label, 'gemini')}.${ext}`)
}

/**
 * Resolve a configured directory against the project root. An absolute
 * `value` is used as-is, so a deployment can point artifacts anywhere.
 *
 * @param {string} root - Absolute project root.
 * @param {string} value - Configured directory, absolute or root-relative.
 * @returns {string} The absolute directory.
 */
export function resolveDir(root, value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value)
}

/**
 * Resolve a model-supplied output path. A relative path is anchored at the
 * project root rather than the harness process directory, so a tool behaves the
 * same no matter where `dsh` was started.
 *
 * @param {string} root - Absolute project root.
 * @param {string} [value] - The requested path; omitted or empty yields `null`.
 * @returns {string | null} The absolute path, or `null` when none was requested.
 */
export function resolveOutputPath(root, value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const trimmed = value.trim()
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(root, trimmed)
}
