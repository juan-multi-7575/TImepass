import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The only place the plugin writes to disk. Artifacts are created on demand and
 * their parent directories with them, so a configured directory that does not
 * exist yet is not an error.
 * @module dsh-timepass-gemini/lib/artifacts
 */

/**
 * Write one artifact, creating its directory first.
 *
 * @param {string} file - Absolute path to write.
 * @param {string | Uint8Array} data - The file contents.
 * @returns {Promise<{ path: string, bytes: number }>} The absolute path and the bytes written.
 */
export async function writeArtifact(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, data)
  const stats = await fs.stat(file)
  return { path: file, bytes: stats.size }
}

/**
 * Read and parse a JSON file, reporting a usable message for the two failures
 * an operator can actually cause: a wrong path, and a half-written backup.
 *
 * @param {string} file - Absolute path to read.
 * @returns {Promise<unknown>} The parsed value.
 */
export async function readJsonFile(file) {
  let raw
  try {
    raw = await fs.readFile(file, 'utf-8')
  } catch {
    throw new Error('No such file: ' + file)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(file + ' is not valid JSON: ' + (error instanceof Error ? error.message : String(error)))
  }
}
